from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query

from ..core import default_season_week, get_db

router = APIRouter(prefix="/api", tags=["defenses"])
POS = ("QB", "RB", "WR", "TE")


def _weeks_for(c, season, week, defense, window):
    ws = [r[0] for r in c.execute("SELECT DISTINCT week FROM team_game WHERE season=? AND week<? AND opponent=? ORDER BY week DESC",
                                  (season, week, defense))]
    return sorted(ws[:window] if window else ws)


def _summary(c, season, week, defense, window):
    weeks = _weeks_for(c, season, week, defense, window)
    if not weeks:
        return {"defense": defense, "games": 0, "weeks": [], "positions": {}, "available": False}
    ph = ",".join("?" * len(weeks))
    pos_rows = {r["position"]: dict(r) for r in c.execute(f"""
        SELECT position, SUM(touchdowns) tds, SUM(rush_tds) rush_tds, SUM(rec_tds) rec_tds, SUM(xtd) xtd, SUM(opportunities) opps,
               SUM(goal5_carries) goal5_carries, SUM(goal10_carries) goal10_carries, SUM(rz_carries) rz_carries,
               SUM(goal5_targets) goal5_targets, SUM(goal10_targets) goal10_targets, SUM(rz_targets) rz_targets,
               SUM(ez_target_proxy) ez_target_proxy
        FROM def_pos_game WHERE season=? AND defense=? AND week IN ({ph}) GROUP BY position""", [season, defense, *weeks])}
    off = c.execute(f"""SELECT SUM(points) pts, SUM(offensive_tds) tds, SUM(xtd) xtd, SUM(rz_trips) rz_trips,
                        SUM(rz_td_drives) rz_td, SUM(plays) plays, SUM(drives) drives
                        FROM team_game WHERE season=? AND opponent=? AND week IN ({ph})""", [season, defense, *weeks]).fetchone()
    n = len(weeks)
    positions = {}
    for p in POS:
        r = pos_rows.get(p, {})
        positions[p] = {k: (r.get(k) or 0) for k in ("tds", "rush_tds", "rec_tds", "xtd", "opps", "goal5_carries", "goal10_carries",
                                                       "rz_carries", "goal5_targets", "goal10_targets", "rz_targets", "ez_target_proxy")}
        positions[p]["tds_pg"] = positions[p]["tds"] / n
        positions[p]["xtd_pg"] = positions[p]["xtd"] / n
    return {"defense": defense, "games": n, "weeks": weeks, "available": True, "positions": positions,
            "points_allowed_pg": (off["pts"] or 0) / n if off["pts"] is not None else None,
            "offensive_tds_allowed_pg": (off["tds"] or 0) / n, "xtd_allowed_pg": (off["xtd"] or 0) / n,
            "rz_trips_allowed": off["rz_trips"], "rz_td_drives_allowed": off["rz_td"],
            "rz_td_rate_allowed": (off["rz_td"] / off["rz_trips"]) if off["rz_trips"] else None,
            "plays_faced_pg": (off["plays"] or 0) / n if off["plays"] else None, "drives_faced_pg": (off["drives"] or 0) / n if off["drives"] else None}


def _upcoming(c, season, week):
    out = {}
    for g in c.execute("SELECT * FROM games WHERE season=? AND week=?", (season, week)):
        imp_home = (g["total_line"] + g["spread_line"]) / 2 if g["total_line"] is not None and g["spread_line"] is not None else None
        imp_away = (g["total_line"] - g["spread_line"]) / 2 if imp_home is not None else None
        out[g["home_team"]] = {"opponent": g["away_team"], "home": True, "gameday": g["gameday"], "gametime": g["gametime"],
                               "opponent_implied_total": imp_away, "game_id": g["game_id"]}
        out[g["away_team"]] = {"opponent": g["home_team"], "home": False, "gameday": g["gameday"], "gametime": g["gametime"],
                               "opponent_implied_total": imp_home, "game_id": g["game_id"]}
    return out


@router.get("/defenses")
def defenses(season: int | None = None, week: int | None = None, window: int | None = Query(None, ge=1, le=18),
             c: sqlite3.Connection = Depends(get_db)):
    """All defenses, built only from completed games before `week`. window = last N games (default full season)."""
    ds, dw = default_season_week(c)
    season, week = season or ds, week or dw
    teams = [r[0] for r in c.execute("SELECT DISTINCT opponent FROM team_game WHERE season=? ORDER BY opponent", (season,))]
    if not teams:
        return {"season": season, "week": week, "window": window, "teams": [], "league": None,
                "empty_reason": "No play-by-play imported for this season yet."}
    up = _upcoming(c, season, week)
    rows = [_summary(c, season, week, t, window) | {"upcoming": up.get(t)} for t in teams]
    live = [r for r in rows if r["available"]]
    league = {p: {"tds_pg": sum(r["positions"][p]["tds"] for r in live) / max(1, sum(r["games"] for r in live)),
                  "xtd_pg": sum(r["positions"][p]["xtd"] for r in live) / max(1, sum(r["games"] for r in live))} for p in POS}
    trips = sum(r["rz_trips_allowed"] or 0 for r in live)
    league["rz_td_rate"] = sum(r["rz_td_drives_allowed"] or 0 for r in live) / trips if trips else None
    return {"season": season, "week": week, "window": window, "teams": rows, "league": league,
            "coverage": "Coverage tracking not connected: no man/zone or Cover-1-4 charting source is imported.",
            "method": "Allowed stats credit the scoring offensive player's position; they describe where TDs happened, "
                      "not which defenders were responsible. Red-zone TD rate = opponent drives reaching the 20 that ended in a TD."}


@router.get("/defenses/{team}")
def defense_detail(team: str, season: int | None = None, week: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    ds, dw = default_season_week(c)
    season, week = season or ds, week or dw
    team = team.upper()
    full = _summary(c, season, week, team, None)
    if not full["available"]:
        raise HTTPException(404, f"No completed games for {team} before {season} Week {week}")
    weekly = [dict(r) for r in c.execute("""SELECT week, opponent AS offense, position, touchdowns, xtd, opportunities, rz_carries,
                                            rz_targets, goal5_carries, goal5_targets, ez_target_proxy FROM def_pos_game
                                            WHERE season=? AND week<? AND defense=? ORDER BY week""", (season, week, team))]
    tds = [dict(r) for r in c.execute("""SELECT e.week, e.offense, e.player_id, e.player_name,
                                         COALESCE(pg.position, e.position) AS position, e.event_type, e.yards_to_goal, e.air_yards, e.description
                                         FROM pbp_events e LEFT JOIN player_game pg ON pg.season=e.season AND pg.week=e.week
                                         AND pg.player_id=e.player_id AND pg.team=e.offense
                                         WHERE e.season=? AND e.week<? AND e.defense=? AND e.td=1 ORDER BY e.week""", (season, week, team))]
    venom = [dict(r) for r in c.execute("SELECT * FROM venom_defense_notes WHERE defense=? AND season=? AND week=?", (team, season, week))]
    return {"season": season, "week": week, "team": team, "full": full, "last6": _summary(c, season, week, team, 6),
            "last3": _summary(c, season, week, team, 3), "weekly": weekly, "touchdowns_allowed": tds,
            "upcoming": _upcoming(c, season, week).get(team), "venom_notes": venom,
            "coverage": "Coverage tracking not connected."}
