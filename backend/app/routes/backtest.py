from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Query

from ..core import get_db, latest_walk_forward, loads

router = APIRouter(prefix="/api/backtest", tags=["backtest"])


def _report(c):
    wf = latest_walk_forward(c)
    return (wf, loads(wf["metrics"], {})) if wf else (None, None)


@router.get("/summary")
def summary(c: sqlite3.Connection = Depends(get_db)):
    wf, m = _report(c)
    if not wf:
        return {"available": False, "empty_reason": "No walk-forward run yet. It runs automatically after a full data import."}
    overall = {k: {kk: vv for kk, vv in v.items() if kk != "calibration"} for k, v in m["overall"].items()}
    return {"available": True, "run_id": wf["run_id"], "created_at": wf["created_at"], "test_weeks": m["test_weeks"],
            "eligible_population": m["eligible_population"], "overall": overall, "by_season": m["by_season"],
            "by_position": m["by_position"], "topn": m["topn"], "gate": m["gate"],
            "method": ["Each test week is predicted by models fit only on player-games from earlier weeks.",
                       "Features use only games before the predicted week; opponent defense splits are recomputed at each cutoff.",
                       "Market spread/total lines come from the nflverse schedule (closing lines for completed games). They are "
                       "public before kickoff but later than a midweek decision, so results may be slightly optimistic.",
                       "Top-N picks come from the pregame pool: weekly roster ACT and not Out/Doubtful on the final injury report. "
                       "A pick who then did not play is void, counted separately.",
                       "xTD conversion rates for season S are learned only from seasons before S."]}


@router.get("/weeks")
def weeks(c: sqlite3.Connection = Depends(get_db)):
    wf, m = _report(c)
    return {"available": bool(wf), "weeks": m["weekly"] if m else []}


@router.get("/calibration")
def calibration(model: str | None = None, c: sqlite3.Connection = Depends(get_db)):
    wf, m = _report(c)
    if not wf:
        return {"available": False}
    names = [model] if model else list(m["overall"].keys())
    return {"available": True, "models": {n: m["overall"][n]["calibration"] for n in names if n in m["overall"]}}


@router.get("/picks")
def picks(model: str | None = None, season: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    wf, m = _report(c)
    if not wf:
        return {"available": False, "picks": []}
    model = model or m["gate"].get("promoted") or "fg-structural-1"
    out = [p for p in m["picks"] if p["model"] == model and (season is None or p["season"] == season)]
    return {"available": True, "model": model, "picks": out}


@router.get("/week-detail")
def week_detail(season: int, week: int, model: str | None = None, limit: int = Query(25, le=200),
                c: sqlite3.Connection = Depends(get_db)):
    """Pregame candidate list for a historical week with realised outcomes (top N by the model)."""
    wf, m = _report(c)
    if not wf:
        return {"available": False, "rows": []}
    model = model or m["gate"].get("promoted") or "fg-structural-1"
    rows = [dict(r) for r in c.execute("""SELECT player_id, player_name, team, position, p, score, outcome, pregame_eligible
                                          FROM backtest_preds WHERE run_id=? AND model=? AND season=? AND week=?
                                          ORDER BY score DESC LIMIT ?""", (wf["run_id"], model, season, week, limit))]
    return {"available": True, "model": model, "season": season, "week": week, "rows": rows}


@router.get("/tuning")
def tuning():
    """Results of the last tuning study (python -m engine.tuning), if one has been run."""
    import json

    from engine import paths

    f = paths.results_dir() / "tuning.json"
    if not f.exists():
        return {"available": False}
    r = json.loads(f.read_text())
    return {"available": True, "created_at": r["created_at"], "selection_weeks": r["selection_weeks"], "holdout_weeks": r["holdout_weeks"],
            "stage_a": [{k: v for k, v in x.items() if k in ("window", "prior_season_weight", "def_shrink_games", "log_loss", "brier",
                                                              "top3_policy_hits", "top3_policy_legs")} for x in r["stage_a"]],
            "stage_b": [{k: v for k, v in x.items() if k in ("added", "accepted", "log_loss", "previous", "all_trials")} for x in r["stage_b"]],
            "c_grid": [{"C": x["C"], "log_loss": x["log_loss"]} for x in r["c_grid"]], "tuned": r["tuned"],
            "comparison": r["comparison"], "adopt": r["adopt"]}
