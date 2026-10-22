from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from engine import props, scoring_trends

from ..core import default_season_week, get_db, loads

router = APIRouter(prefix="/api", tags=["props"])

NO_LINES_NOTE = ("No historical sportsbook prop lines are available, so the backtest's over/under check uses a reference line from "
                 "each player's own recent median (floor + 0.5). Beating that line is evidence of calibration, not proof of beating a book.")


def _markets(c) -> dict:
    rep = props.latest_report(c)
    out = {}
    for key, m in props.MARKETS.items():
        r = (rep or {}).get("markets", {}).get(key)
        entry = {"market": key, "label": m["label"], "positions": list(m["positions"]), "kind": m["kind"], "validated": False,
                 "model": None, "tested": r is not None}
        if r:
            g = r["gate"]
            name = g["promoted"] or g["research_model"]
            mm, base = r["models"][name], r["models"]["baseline-player-avg"]
            entry |= {"validated": g["promoted"] is not None, "model": name, "test_rows": r["n"], "test_weeks": r["weeks"],
                      "crps": mm["crps"], "baseline_crps": base["crps"], "crps_gain_pct": 1 - mm["crps"] / base["crps"],
                      "mae_median": mm["mae_median"], "baseline_mae_median": base["mae_median"], "coverage_10_90": mm["coverage_10_90"],
                      "coverage_expected": mm["coverage_expected"], "over_brier": mm["over_brier"], "over_ece": mm["over_ece"],
                      "lean_n": mm["lean_n"], "lean_hit_rate": mm["lean_hit_rate"],
                      "failed_checks": [k for k, ok in g["candidates"].get(name, {}).get("checks", {}).items() if not ok]}
        out[key] = entry
    return {"markets": list(out.values()), "walk_forward_run": (rep or {}).get("run_id"), "created_at": (rep or {}).get("created_at"),
            "gate_rules": props.GATE, "note": NO_LINES_NOTE}


@router.get("/props/markets")
def markets(c: sqlite3.Connection = Depends(get_db)):
    return _markets(c)


@router.get("/props")
def week_props(season: int | None = None, week: int | None = None, market: str = "rec_yards", c: sqlite3.Connection = Depends(get_db)):
    if market not in props.MARKETS:
        raise HTTPException(404, f"Unknown market {market}")
    ds, dw = default_season_week(c)
    season, week = season or ds, week or dw
    run = c.execute("SELECT run_id, created_at FROM prop_projections JOIN prop_runs USING(run_id) WHERE season=? AND week=? "
                    "ORDER BY created_at DESC LIMIT 1", (season, week)).fetchone()
    meta = next(m for m in _markets(c)["markets"] if m["market"] == market)
    if run is None:
        return {"season": season, "week": week, "market": meta, "rows": [], "run_id": None,
                "empty_reason": f"Prop projections are published for the upcoming week only (not {season} Week {week})."}
    rows = []
    recent = _recent(c, season, week, props.MARKETS[market]["stat"])
    for r in c.execute("SELECT * FROM prop_projections WHERE run_id=? AND market=? ORDER BY eligible DESC, median DESC",
                       (run["run_id"], market)):
        d = dict(r)
        d["recent"] = recent.get((d["player_id"], d["team"]), [])
        d["flags"] = loads(d["flags"], [])
        d["evidence"] = loads(d["evidence"], {})
        d["dist"] = loads(d["dist"], {}) if d["calibrated"] else None  # over/under chances only for validated markets
        rows.append(d)
    return {"season": season, "week": week, "market": meta, "run_id": run["run_id"], "as_of": run["created_at"], "rows": rows,
            "note": NO_LINES_NOTE}


def _recent(c, season: int, week: int, stat: str, n: int = 8) -> dict:
    """Each player's last n games before the target week, most recent first (context for the reader, not a model input)."""
    h = props.load_history(c)
    h = h[(h.season < season) | ((h.season == season) & (h.week < week))]
    out = {}
    for pid, g in h.groupby("player_id", sort=False):
        g = g.iloc[::-1].head(n)
        vals = [{"season": int(s), "week": int(w), "opponent": o, "value": float(v)} for s, w, o, v in zip(g.season, g.week, g.opponent, g[stat])]
        for team in set(g.team):
            out[(pid, team)] = vals
    return out


@router.get("/props/backtest")
def props_backtest(market: str, c: sqlite3.Connection = Depends(get_db)):
    rep = props.latest_report(c)
    if not rep or market not in rep["markets"]:
        raise HTTPException(404, "No walk-forward results for that market yet.")
    r = rep["markets"][market]
    return {"market": market, "label": r["label"], "n": r["n"], "weeks": r["weeks"], "gate": r["gate"], "models": r["models"],
            "over_rate_at_reference": r["over_rate_at_reference"], "note": NO_LINES_NOTE}


@router.get("/scoring-trends")
def trends(season: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    ds, _ = default_season_week(c)
    return scoring_trends.build(c, season or ds)
