from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from engine import status

from ..core import default_season_week, get_db, latest_walk_forward, loads, prediction_run
from .top3 import weekly_top3

router = APIRouter(prefix="/api", tags=["overview"])


@router.get("/overview")
def overview(season: int | None = None, week: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    ds, dw = default_season_week(c)
    season, week = season or ds, week or dw
    st = status.read_build_status() or {}
    srcs = status.source_rows(c, season)
    run = prediction_run(c, season, week)
    games = []
    for g in c.execute("SELECT * FROM games WHERE season=? AND week=? ORDER BY gameday, gametime", (season, week)):
        imp_h = (g["total_line"] + g["spread_line"]) / 2 if g["total_line"] is not None and g["spread_line"] is not None else None
        games.append({"game_id": g["game_id"], "away": g["away_team"], "home": g["home_team"], "gameday": g["gameday"],
                      "gametime": g["gametime"], "total": g["total_line"], "spread": g["spread_line"],
                      "home_implied": imp_h, "away_implied": (g["total_line"] - imp_h) if imp_h is not None else None,
                      "away_score": g["away_score"], "home_score": g["home_score"]})
    opps, vulns = [], []
    if run:
        for r in c.execute("""SELECT player_id, player_name, team, opponent, position, rank, features FROM predictions
                              WHERE run_id=? AND eligible=1 ORDER BY CAST(json_extract(features,'$.rz_carries_pg') AS REAL)
                              + CAST(json_extract(features,'$.rz_targets_pg') AS REAL) DESC LIMIT 5""", (run["run_id"],)):
            f = loads(r["features"], {})
            opps.append({"player_id": r["player_id"], "player_name": r["player_name"], "team": r["team"], "opponent": r["opponent"],
                         "position": r["position"], "rank": r["rank"], "rz_carries_pg": f.get("rz_carries_pg"),
                         "rz_targets_pg": f.get("rz_targets_pg"), "goal5_carries_pg": f.get("goal5_carries_pg")})
        seen = set()
        for r in c.execute("""SELECT opponent, position, json_extract(features,'$.opp_def_pos_td_pg_raw') raw,
                              json_extract(features,'$.opp_def_games') games, json_extract(features,'$.league_pos_td_pg') lg,
                              json_extract(features,'$.opp_def_pos_mult') mult, team FROM predictions WHERE run_id=? AND eligible=1
                              AND json_extract(features,'$.opp_def_games') >= 3
                              ORDER BY (CAST(raw AS REAL) - CAST(lg AS REAL)) DESC""", (run["run_id"],)):
            key = (r["opponent"], r["position"])
            if key in seen:
                continue
            seen.add(key)
            vulns.append({"defense": r["opponent"], "position": r["position"], "tds_pg": r["raw"], "games": r["games"],
                          "league_tds_pg": r["lg"], "offense": r["team"]})
            if len(vulns) == 6:
                break
    perf = None
    wf = latest_walk_forward(c)
    if wf:
        m = loads(wf["metrics"], {})
        promoted = m["gate"].get("promoted")
        name = promoted or "fg-structural-1"
        perf = {"model": name, "promoted": promoted, "overall": {k: v for k, v in m["overall"][name].items() if k != "calibration"},
                "baseline": {k: v for k, v in m["overall"]["baseline-shrunk-player-rate"].items() if k != "calibration"},
                "top3": m["topn"][name]["top3"], "top3_policy": m["topn"][name]["top3_policy"],
                "recent_weeks": [{"season": w["season"], "week": w["week"], "hits": w.get(f"{name}::top3_hits"),
                                  "graded": w.get(f"{name}::top3_graded")} for w in m["weekly"][-6:]]}
    last_import = c.execute("SELECT MAX(imported_at) FROM sources WHERE status='ok'").fetchone()[0]
    return {"season": season, "week": week, "ready": bool(st.get("ready")), "data_loaded": bool(st.get("data_loaded")),
            "analytics_through_week": max(st.get("current_weeks") or [0]) if st.get("season") == season else None,
            "sources_ok": sum(s["status"] == "ok" for s in srcs), "sources_total": len(srcs),
            "required_missing": [f"{s['kind']} {s['season'] or ''}".strip() for s in srcs if s["required"] and s["status"] != "ok"],
            "last_import": last_import, "latest_completed_gameday": st.get("latest_completed_gameday"),
            "games": games, "top3": weekly_top3(season, week, [], c), "opportunity_leaders": opps,
            "defense_vulnerabilities": vulns, "model_performance": perf,
            "prediction_run": dict(run) if run else None, "error": st.get("error")}
