"""Data-quality gates and build_status.json (superset of the handoff's original fields)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from . import paths, sources
from .util import utcnow

GATES = {"min_training_events": 50_000, "min_current_offenses": 30, "min_current_games": 70, "min_roster_rows": 1000}


def current_week(c: sqlite3.Connection, season: int) -> int | None:
    """First regular-season week with an unplayed game, else the week after the last one."""
    r = c.execute("SELECT MIN(week) FROM games WHERE season=? AND home_score IS NULL", (season,)).fetchone()
    if r and r[0]:
        return int(r[0])
    r = c.execute("SELECT MAX(week) FROM pbp_events WHERE season=?", (season,)).fetchone()
    return int(r[0]) + 1 if r and r[0] else None


def latest_season(c: sqlite3.Connection) -> int | None:
    r = c.execute("SELECT MAX(season) FROM pbp_events").fetchone()
    return int(r[0]) if r and r[0] else None


def gates(c: sqlite3.Connection, season: int, week: int) -> list[dict]:
    train = c.execute("SELECT COUNT(*) FROM pbp_events WHERE season<?", (season,)).fetchone()[0]
    off, games = c.execute("SELECT COUNT(DISTINCT offense), COUNT(DISTINCT game_id) FROM pbp_events WHERE season=? AND week<?",
                           (season, week)).fetchone()
    weeks = [r[0] for r in c.execute("SELECT DISTINCT week FROM pbp_events WHERE season=? AND week<? ORDER BY week", (season, week))]
    roster = c.execute("SELECT COUNT(*) FROM roster_week WHERE season=?", (season,)).fetchone()[0]
    expected_weeks = list(range(1, week))
    # A full slate is ~16 games/week; scale the handoff's 70-game gate (set for Week 7) to the cutoff.
    min_games = min(GATES["min_current_games"], max(0, (week - 1) * 12))
    return [
        {"gate": "Training PBP events before this season", "value": train, "threshold": GATES["min_training_events"],
         "pass": train >= GATES["min_training_events"]},
        {"gate": f"{season} offenses with PBP before Week {week}", "value": off, "threshold": GATES["min_current_offenses"],
         "pass": week == 1 or off >= GATES["min_current_offenses"]},
        {"gate": f"{season} games with PBP before Week {week}", "value": games, "threshold": min_games,
         "pass": games >= min_games},
        {"gate": f"{season} PBP week coverage through Week {week - 1}", "value": weeks, "threshold": expected_weeks,
         "pass": weeks == expected_weeks},
        {"gate": f"{season} offensive roster player-weeks", "value": roster, "threshold": GATES["min_roster_rows"],
         "pass": roster >= GATES["min_roster_rows"]},
    ]


def source_rows(c: sqlite3.Connection, season: int) -> list[dict]:
    rows = {(r["kind"], r["season"]): dict(r) for r in c.execute("SELECT * FROM sources")}
    out = []
    for p in sources.plan(season):
        r = rows.get((p["kind"], p["season"]))
        local = paths.raw_dir() / sources.local_name(p["kind"], p["season"])
        out.append({"kind": p["kind"], "season": p["season"] or None, "required": p["required"],
                    "description": sources.KINDS[p["kind"]].description, "local_file": local.name,
                    "local_present": local.exists(), "source_url": sources.url_for(p["kind"], p["season"]),
                    "status": (r or {}).get("status", "not_imported"), "rows_imported": (r or {}).get("rows_imported"),
                    "imported_at": (r or {}).get("imported_at"), "file_mtime": (r or {}).get("file_mtime"),
                    "sha256": (r or {}).get("sha256"), "file_bytes": (r or {}).get("file_bytes"), "message": (r or {}).get("message")})
    return out


def write_build_status(c: sqlite3.Connection, season: int | None = None, week: int | None = None, error: str | None = None,
                       extra: dict | None = None) -> dict:
    season = season or latest_season(c) or 2026
    week = week or current_week(c, season) or 1
    g = gates(c, season, week)
    srcs = source_rows(c, season)
    required_ok = all(s["status"] == "ok" for s in srcs if s["required"])
    ev_cur = c.execute("SELECT COUNT(*), COUNT(DISTINCT offense), COUNT(DISTINCT game_id) FROM pbp_events WHERE season=? AND week<?",
                       (season, week)).fetchone()
    wf = c.execute("SELECT run_id, created_at, gate FROM model_runs WHERE kind='walk_forward' ORDER BY created_at DESC LIMIT 1").fetchone()
    gate = json.loads(wf["gate"]) if wf else None
    pred = c.execute("SELECT run_id, model_version, calibrated, created_at, data_cutoff FROM model_runs WHERE kind='prediction' "
                     "AND season=? AND week=? ORDER BY created_at DESC LIMIT 1", (season, week)).fetchone()
    weeks_cur = [r[0] for r in c.execute("SELECT DISTINCT week FROM pbp_events WHERE season=? AND week<? ORDER BY week", (season, week))]
    status = {
        # Original handoff fields
        "season": season, "prediction_week": week,
        "train_seasons": [r[0] for r in c.execute("SELECT DISTINCT season FROM pbp_events WHERE season<? ORDER BY season", (season,))],
        "independent_pbp_training_events": c.execute("SELECT COUNT(*) FROM pbp_events WHERE season<?", (season,)).fetchone()[0],
        f"imported_{season}_pbp_events": ev_cur[0], f"imported_{season}_offenses": ev_cur[1], f"imported_{season}_games": ev_cur[2],
        "current_weeks": weeks_cur,
        "players_weekly_rows": c.execute("SELECT COUNT(*) FROM player_week WHERE season=? AND week<?", (season, week)).fetchone()[0],
        "offensive_roster_player_weeks": c.execute("SELECT COUNT(*) FROM roster_week WHERE season=?", (season,)).fetchone()[0],
        "player_opportunity_rows": c.execute("SELECT COUNT(*) FROM player_game WHERE season=? AND week<? AND opportunities>0",
                                             (season, week)).fetchone()[0],
        "defense_rows": c.execute("SELECT COUNT(*) FROM def_pos_game WHERE season=? AND week<?", (season, week)).fetchone()[0],
        "NOT_CHARTED": "End zone target uses air_yards >= yardline_100 proxy; incompletions are NOT labeled drops",
        "DATA_SOURCE": "https://github.com/nflverse/nflverse-data/releases",
        "BACKTEST_WARNING": "Historical opportunity xTD is NOT a calibrated full-game touchdown probability.",
        # Extended fields
        "generated_at": utcnow(), "engine_version": paths.ENGINE_VERSION,
        "data_loaded": required_ok and ev_cur[0] > 0,
        "ready": required_ok and all(x["pass"] for x in g) and error is None,
        "gates": g, "sources": srcs, "error": error,
        "latest_completed_gameday": c.execute("SELECT MAX(gameday) FROM games WHERE season=? AND home_score IS NOT NULL", (season,)).fetchone()[0],
        "model": {"walk_forward_run": wf["run_id"] if wf else None, "walk_forward_at": wf["created_at"] if wf else None,
                  "promoted": gate["promoted"] if gate else None, "calibrated": bool(gate and gate["promoted"])},
        "prediction_run": dict(pred) if pred else None,
        "coverage_tracking": "not connected (no man/zone charting source imported)",
        "license": sources.LICENSE_NOTE,
    }
    if extra:
        status.update(extra)
    out = paths.results_dir()
    out.mkdir(parents=True, exist_ok=True)
    (out / "build_status.json").write_text(json.dumps(status, indent=2, default=str))
    return status


def read_build_status() -> dict | None:
    p = paths.results_dir() / "build_status.json"
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text())
        d["_file_mtime"] = Path(p).stat().st_mtime
        return d
    except json.JSONDecodeError:
        return None
