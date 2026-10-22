from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from engine import correlation, odds

from ..core import default_season_week, get_db

router = APIRouter(prefix="/api", tags=["parlay"])

NOTE = ("Legs from different games are treated as independent. Legs from the same game share a correlation learned from "
        "past walk-forward predictions; it is used only because it beat simple multiplication on unseen weeks.")


@router.get("/parlay/model")
def parlay_model(c: sqlite3.Connection = Depends(get_db)):
    rep = correlation.latest(c)
    if rep is None:
        return {"run_id": None, "use_correlation": False, "buckets": {}, "validation": None,
                "empty_reason": "The correlation study has not been run yet; same-game chances are multiplied as if independent."}
    v = rep["validation"]
    slim = lambda s: {k: s[k] for k in ("n", "weeks", "both_hit_rate", "independent", "correlated", "log_loss_gain", "gain_ci", "calibration")}  # noqa: E731
    return {"run_id": rep["run_id"], "created_at": rep["created_at"], "use_correlation": rep["use_correlation"], "method": rep["method"],
            "source": rep["source"], "events": rep["events"], "pairs": rep["pairs"],
            "buckets": {k: {"rho": b["rho"], "pairs": b["pairs"]} for k, b in rep["buckets"].items()},
            "validation": {"pairs": slim(v["pairs"]), "triples": slim(v["triples"]), "latest_season_pairs": slim(v["latest_season_pairs"]),
                           "by_relation": {r: slim(x) for r, x in v["by_relation"].items()}, "gate": v["gate"]},
            "note": NOTE}


@router.get("/odds")
def week_odds(season: int | None = None, week: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    ds, dw = default_season_week(c)
    season, week = season or ds, week or dw
    snap = odds.load_snapshot(season, week)
    if snap is None:
        return {"season": season, "week": week, "fetched_at": None, "rows": [],
                "empty_reason": "No sportsbook prices have been fetched for this week. Type prices in, or add an ODDS_API_KEY."}
    return snap


@router.get("/odds/record")
def odds_record(c: sqlite3.Connection = Depends(get_db)):
    return odds.record(c)
