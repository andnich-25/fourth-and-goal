from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from ..core import default_season_week, get_db, loads, prediction_run

router = APIRouter(prefix="/api", tags=["players"])

SPLITS = [("<=5", 1, 5), ("6-10", 6, 10), ("11-20", 11, 20), ("21-40", 21, 40), ("41+", 41, 99)]


@router.get("/players/{player_id}")
def player(player_id: str, season: int | None = None, week: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    ds, dw = default_season_week(c)
    season, week = season or ds, week or dw
    ident = c.execute("""SELECT player_id, player_name, position, team, depth_position, status, headshot_url FROM roster_week
                         WHERE player_id=? AND season=? ORDER BY week DESC LIMIT 1""", (player_id, season)).fetchone()
    games = [dict(r) for r in c.execute("""SELECT * FROM player_game WHERE player_id=? AND season=? AND week<? ORDER BY week""",
                                        (player_id, season, week))]
    if not ident and not games:
        any_row = c.execute("SELECT player_name, position, team FROM player_game WHERE player_id=? ORDER BY season DESC, week DESC LIMIT 1",
                            (player_id,)).fetchone()
        if not any_row:
            raise HTTPException(404, "Player not found in imported data")
        ident = any_row
    # Event ledger: every counted rush/target from scoring range (inside the 20) plus any TD, before the cutoff.
    events = [dict(r) for r in c.execute("""
        SELECT season, week, game_id, play_id, offense, defense, event_type, yards_to_goal, air_yards, completed, td, ez_proxy,
               xtd, description FROM pbp_events
        WHERE player_id=? AND season=? AND week<? AND (yards_to_goal<=20 OR td=1)
        ORDER BY week, CAST(play_id AS INTEGER)""", (player_id, season, week))]
    for e in events:
        e["miss_label"] = None if e["td"] else ("Missed scoring opportunity (target, no TD)" if e["event_type"] == "pass"
                                                 else "Missed scoring opportunity (carry, no TD)")
        e["ez_label"] = "End-zone target proxy" if e["ez_proxy"] else None
    splits = []
    for label, lo, hi in SPLITS:
        r = c.execute("""SELECT SUM(event_type='run') carries, SUM(event_type='pass') targets, SUM(td) tds, SUM(xtd) xtd,
                         SUM(event_type='pass' AND ez_proxy=1) ez_proxy FROM pbp_events
                         WHERE player_id=? AND season=? AND week<? AND yards_to_goal BETWEEN ? AND ?""",
                      (player_id, season, week, lo, hi)).fetchone()
        splits.append({"zone": label, **{k: (r[k] or 0) for k in r.keys()}})
    run = prediction_run(c, season, week)
    pred = None
    if run:
        p = c.execute("SELECT * FROM predictions WHERE run_id=? AND player_id=?", (run["run_id"], player_id)).fetchone()
        if p:
            f = loads(p["features"], {})
            pred = {"rank": p["rank"], "score": p["score"], "p_model": p["p_model"] if run["calibrated"] else None,
                    "calibrated": bool(run["calibrated"]), "model_version": run["model_version"], "eligible": bool(p["eligible"]),
                    "exclusion": p["exclusion"], "confidence": p["confidence"], "flags": loads(p["flags"], []),
                    "reasons": f.pop("reasons", []), "features": f, "opponent": p["opponent"], "game_id": p["game_id"],
                    "team": p["team"], "outcome": p["outcome"], "data_cutoff": run["data_cutoff"]}
    team = (pred or {}).get("team") or (games[-1]["team"] if games else ident["team"])
    # Team usage share per week (player opportunities / team rush+target opportunities).
    usage = []
    for g in games:
        t = c.execute("SELECT SUM(carries+targets) FROM player_game WHERE season=? AND week=? AND team=?", (season, g["week"], g["team"])).fetchone()[0]
        tx = c.execute("SELECT xtd, offensive_tds FROM team_game WHERE season=? AND week=? AND team=?", (season, g["week"], g["team"])).fetchone()
        usage.append({"week": g["week"], "opp_share": (g["carries"] + g["targets"]) / t if t else None,
                      "xtd_share": (g["xtd"] / tx["xtd"]) if tx and tx["xtd"] and g["xtd"] is not None else None,
                      "team_tds": tx["offensive_tds"] if tx else None})
    matchup = None
    opp = (pred or {}).get("opponent")
    pos = ident["position"]
    if opp:
        rows = [dict(r) for r in c.execute("""SELECT week, opponent AS offense, touchdowns, xtd, rz_carries, rz_targets, goal5_carries,
                                              goal5_targets FROM def_pos_game WHERE season=? AND week<? AND defense=? AND position=?
                                              ORDER BY week""", (season, week, opp, pos))]
        matchup = {"defense": opp, "position": pos, "games": rows}
    return {"player_id": player_id, "player_name": ident["player_name"], "position": pos, "team": team,
            "headshot_url": ident["headshot_url"] if "headshot_url" in ident.keys() else None,
            "roster_status": ident["status"] if "status" in ident.keys() else None, "season": season, "week": week,
            "prediction": pred, "games": games, "events": events, "field_splits": splits, "usage": usage, "matchup": matchup,
            "definitions": {"miss": "A rush or target that did not produce a TD. Not a drop: catchability is not in play-by-play data.",
                            "ez_proxy": "End-zone target proxy = air yards >= yards to goal at the snap. Not a charted ball location.",
                            "xtd": "Play-based xTD = historical TD rate for that play type and field position, learned only from earlier seasons."}}


@router.get("/players")
def search_players(q: str, season: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    ds, _ = default_season_week(c)
    season = season or ds
    return [dict(r) for r in c.execute("""SELECT player_id, player_name, position, team, COUNT(*) games FROM player_game
                                          WHERE season=? AND player_name LIKE ? AND position IN ('QB','RB','WR','TE')
                                          GROUP BY player_id ORDER BY games DESC LIMIT 20""", (season, f"%{q}%"))]
