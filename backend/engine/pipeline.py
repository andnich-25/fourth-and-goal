"""Orchestrates sync -> build -> backtest -> predict, writing build_status.json at every exit."""
from __future__ import annotations

import pickle
import uuid
from pathlib import Path

import pandas as pd

from . import aggregates, backtest, correlation, db, odds, features, ingest, paths, predict, props, sources, status
from .util import utcnow


def features_cache() -> Path:
    return paths.results_dir() / "features.pkl"


def run_sync(c, season=2026, download=False, force=False, log=print) -> list[dict]:
    results = []
    for p in sources.plan(season):
        kind, yr = p["kind"], p["season"]
        path = paths.raw_dir() / sources.local_name(kind, yr)
        if download:
            try:
                # Current-season files and the schedule change weekly; refresh them when older than 6 hours.
                live = kind == "schedules" or yr == season
                path = ingest.download(kind, yr, paths.raw_dir(), log, force=force, max_age_hours=6 if live else None)
            except RuntimeError as ex:
                log(f"DOWNLOAD ERROR: {ex}")
        res = ingest.import_file(c, kind, yr, path, force=force, log=log)
        res["required"] = p["required"]
        results.append(res)
    failed = [r for r in results if r["required"] and r["status"] in ("missing", "error")]
    if failed:
        raise RuntimeError("Required source files missing or invalid: " +
                           ", ".join(f"{r['kind']} {r['season']} ({r['status']})" for r in failed))
    return results


def run_build(c, season=2026, log=print) -> dict:
    xr = aggregates.build_xtd(c, log)
    n_pg = aggregates.build_player_game(c, log)
    td = aggregates.build_team_and_defense(c, log)
    seasons = list(range(sources.history_start(season) + 1, season + 1))
    wk = status.current_week(c, season)
    targets = features.build_targets(c, seasons, extra_weeks=[(season, wk)] if wk else None)
    feats = features.compute_features(c, targets)
    features_cache().parent.mkdir(parents=True, exist_ok=True)
    with open(features_cache(), "wb") as f:
        pickle.dump({"built_at": utcnow(), "season": season, "frame": feats}, f)
    build_id = "b-" + uuid.uuid4().hex[:10]
    summary = {"xtd": {str(k): v for k, v in xr.items()}, "player_games": n_pg, **td, "feature_rows": int(len(feats))}
    with c:
        c.execute("INSERT INTO builds VALUES (?,?,?,?,?,?,?)", (build_id, utcnow(), paths.ENGINE_VERSION, season, wk, "ok", str(summary)))
    log(f"features: {len(feats):,} pregame rows cached")
    return {"build_id": build_id, **summary}


def load_features() -> pd.DataFrame:
    with open(features_cache(), "rb") as f:
        return pickle.load(f)["frame"]


def test_weeks(c, season: int) -> list[tuple[int, int]]:
    """Every regular-season week from TEST_SEASONS back through the last completed week of this season."""
    wk = status.current_week(c, season) or 19
    rows = c.execute("SELECT DISTINCT season, week FROM games WHERE season BETWEEN ? AND ? AND home_score IS NOT NULL "
                     "ORDER BY season, week", (season - sources.TEST_SEASONS, season)).fetchall()
    return [(s, w) for s, w in rows if s < season or w < wk]


def run_backtest(c, season=2026, log=print) -> dict:
    feats = load_features()
    test = test_weeks(c, season)
    have = set(zip(feats.season, feats.week))
    test = [t for t in test if t in have]
    return backtest.walk_forward(c, feats, test, log)


def run_predict(c, season=2026, weeks=None, log=print) -> list[dict]:
    feats = load_features()
    gate = predict.latest_gate(c)
    cur = status.current_week(c, season)
    if weeks is None:
        weeks = [(season - 1, w) for w in range(1, 19)] + [(season, w) for w in range(1, (cur or 1) + 1)]
    out = []
    for s, w in weeks:
        g = status.gates(c, s, w)
        if not all(x["pass"] for x in g):
            out.append({"season": s, "week": w, "skipped": [x["gate"] for x in g if not x["pass"]]})
            continue
        try:
            out.append(predict.predict_week(c, feats, s, w, gate, log))
        except RuntimeError as ex:
            out.append({"season": s, "week": w, "skipped": [str(ex)]})
    return out


def run_props(c, season=2026, log=print) -> dict:
    """Prop projections: walk-forward over the same test weeks as the TD model, then project the upcoming week."""
    feats = load_features()
    wk = status.current_week(c, season)
    frame = props.build_frame(c, props.upcoming_rows(feats, season, wk) if wk else None)
    test = test_weeks(c, season)
    have = set(zip(frame[frame.labelled == 1].season, frame[frame.labelled == 1].week))
    rep = props.walk_forward(c, frame, [t for t in test if t in have], log=log)
    out = {"walk_forward": rep["run_id"], "promoted": {m: r["gate"]["promoted"] for m, r in rep["markets"].items()}}
    if wk:
        out["projection"] = props.project_week(c, frame, season, wk, log)
        # Game simulation: re-tested on every backtest week each run; blended in only where it beat the model alone.
        try:
            from . import gamesim  # noqa: PLC0415
            sim = gamesim.run(c, frame, log)
            out["gamesim"] = {m: r["adopt"] for m, r in sim["markets"].items()}
            gamesim.attach(c, frame, season, wk, out["projection"]["run_id"], log)
        except Exception as ex:  # noqa: BLE001 - the site still builds on the model alone
            log(f"gamesim: skipped ({ex})")
    return out


def run_all(season=2026, download=False, force=False, steps=("sync", "build", "backtest", "predict", "props", "correlation", "schemes", "odds", "picklog"), log=print) -> dict:
    c = db.connect(paths.db_path())
    try:
        res = {}
        if "sync" in steps:
            res["sync"] = run_sync(c, season, download, force, log)
        if "build" in steps:
            res["build"] = run_build(c, season, log)
        if "backtest" in steps:
            rep = run_backtest(c, season, log)
            res["backtest"] = {"run_id": rep["run_id"], "promoted": rep["gate"]["promoted"]}
        if "predict" in steps:
            res["predict"] = run_predict(c, season, log=log)
        if "props" in steps:
            res["props"] = run_props(c, season, log)
        if "correlation" in steps:
            rep = correlation.run(c, log)
            res["correlation"] = {"run_id": rep["run_id"], "used": rep["use_correlation"]}
        if "schemes" in steps:
            from . import schemes  # noqa: PLC0415
            try:
                rep = schemes.run(season, download, log)
                res["schemes"] = {"available": rep.get("available"), "through_week": rep.get("through_week")}
            except Exception as ex:  # noqa: BLE001 - the schemes page is extra; never stop the picks for it
                log(f"schemes skipped: {ex}")
        if "odds" in steps:
            snap = odds.maybe_fetch(c, season, log)
            res["odds"] = {"fetched_at": snap["fetched_at"], "rows": len(snap["rows"])} if snap else None
        if "picklog" in steps:
            from . import picklog  # noqa: PLC0415
            rep = picklog.run(c, season, log)
            res["picklog"] = {"graded": rep.get("graded", 0)}
        st = status.write_build_status(c, season)
        log(f"build_status.json written: ready={st['ready']} promoted={st['model']['promoted']}")
        return res
    except Exception as ex:
        status.write_build_status(c, season, error=str(ex))
        log(f"PIPELINE STOPPED: {ex}")
        raise
    finally:
        c.close()
