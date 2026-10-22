"""Sportsbook prices from The Odds API (https://the-odds-api.com), a licensed odds feed.

  ODDS_API_KEY=... python -m engine.odds            # fetch the upcoming week if no snapshot exists yet
  ODDS_API_KEY=... python -m engine.odds --force    # fetch again

Each fetch costs [markets] x [regions] credits per game (6 x 1 here, about 90-100 a week). The free plan has
500 credits a month, so the hosted site fetches once a week and keeps the snapshot between runs. Prices are
stored as published, with the time they were fetched; nothing is filled in or adjusted. Players are matched to
our players by name within the two teams of each game; unmatched names are kept and counted, never guessed.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import db, paths, status
from .util import utcnow

API = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl"
# our market -> feed market
MARKETS = {
    "td": "player_anytime_td",
    "receptions": "player_receptions",
    "pass_yards": "player_pass_yds",
    "pass_tds": "player_pass_tds",
    "interceptions": "player_pass_interceptions",
    "carries": "player_rush_attempts",
}
BOOKS = {"draftkings": "DraftKings", "fanduel": "FanDuel", "betmgm": "BetMGM", "williamhill_us": "Caesars", "espnbet": "ESPN BET",
         "fanatics": "Fanatics", "betrivers": "BetRivers", "ballybet": "Bally Bet", "hardrockbet": "Hard Rock", "betonlineag": "BetOnline",
         "bovada": "Bovada", "mybookieag": "MyBookie", "betus": "BetUS", "lowvig": "LowVig"}
TEAMS = {"Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF", "Carolina Panthers": "CAR",
         "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL", "Denver Broncos": "DEN",
         "Detroit Lions": "DET", "Green Bay Packers": "GB", "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
         "Kansas City Chiefs": "KC", "Los Angeles Rams": "LA", "Los Angeles Chargers": "LAC", "Las Vegas Raiders": "LV", "Miami Dolphins": "MIA",
         "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG", "New York Jets": "NYJ",
         "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "Seattle Seahawks": "SEA", "San Francisco 49ers": "SF",
         "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WAS"}


def odds_dir() -> Path:
    return paths.data_dir() / "odds"


def snapshot_path(season: int, week: int) -> Path:
    return odds_dir() / f"{season}-w{week:02d}.json"


def load_snapshot(season: int, week: int) -> dict | None:
    p = snapshot_path(season, week)
    return json.loads(p.read_text()) if p.exists() else None


def norm_name(s: str) -> str:
    s = re.sub(r"[^a-z ]", "", s.lower().replace("-", " "))
    return " ".join(w for w in s.split() if w not in {"jr", "sr", "ii", "iii", "iv", "v"})


def _get(url: str, params: dict) -> tuple[object, dict]:
    req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers={"User-Agent": "fourth-and-goal"})
    from .ingest import _ssl_context  # noqa: PLC0415
    with urllib.request.urlopen(req, timeout=60, context=_ssl_context()) as r:
        return json.loads(r.read()), {k.lower(): v for k, v in r.headers.items()}


def _week_games(c: sqlite3.Connection, season: int, week: int) -> list[dict]:
    rows = c.execute("SELECT game_id, gameday, gametime, home_team, away_team, home_score FROM games WHERE season=? AND week=?",
                     (season, week)).fetchall()
    return [dict(r) for r in rows]


def _players(c: sqlite3.Connection, season: int, week: int) -> dict[tuple[str, str], tuple[str, str]]:
    """(team, normalized name) -> (player_id, name) for everyone we project this week."""
    out = {}
    for r in c.execute("SELECT DISTINCT player_id, player_name, team FROM prop_projections WHERE season=? AND week=? "
                       "UNION SELECT DISTINCT player_id, player_name, team FROM predictions WHERE season=? AND week=?",
                       (season, week, season, week)):
        out[(r["team"], norm_name(r["player_name"]))] = (r["player_id"], r["player_name"])
    return out


def fetch(c: sqlite3.Connection, season: int, week: int, key: str, log=print) -> dict:
    games = _week_games(c, season, week)
    if not games:
        raise RuntimeError(f"No games for {season} week {week}")
    by_teams = {(g["home_team"], g["away_team"]): g for g in games if g["home_score"] is None}
    events, hdr = _get(f"{API}/events", {"apiKey": key})
    remaining = hdr.get("x-requests-remaining")
    todo = []
    for e in events:  # type: ignore[union-attr]
        h, a = TEAMS.get(e["home_team"]), TEAMS.get(e["away_team"])
        if (h, a) in by_teams:
            todo.append((e, by_teams[(h, a)]))
    cost = len(todo) * len(MARKETS)
    log(f"odds: {len(todo)} upcoming games matched, about {cost} credits needed, {remaining} remaining")
    if remaining is not None and float(remaining) < cost:
        raise RuntimeError(f"Not enough Odds API credits left this month ({remaining} < {cost}); keeping the previous snapshot.")
    players = _players(c, season, week)
    rows, unmatched, errors = [], {}, []
    for e, g in todo:
        try:
            data, hdr = _get(f"{API}/events/{e['id']}/odds", {"apiKey": key, "regions": "us", "oddsFormat": "american",
                                                              "markets": ",".join(MARKETS.values())})
        except urllib.error.HTTPError as ex:
            errors.append(f"{g['game_id']}: HTTP {ex.code}")
            log(f"odds: {g['game_id']} HTTP {ex.code} {ex.read()[:200]!r}")
            continue
        remaining = hdr.get("x-requests-remaining", remaining)
        feed_to_ours = {v: k for k, v in MARKETS.items()}
        for b in data.get("bookmakers", []):  # type: ignore[union-attr]
            book = BOOKS.get(b["key"], b.get("title", b["key"]))
            for m in b.get("markets", []):
                market = feed_to_ours.get(m["key"])
                if not market:
                    continue
                for o in m.get("outcomes", []):
                    name = o.get("description") or ""
                    side = {"over": "over", "under": "under", "yes": "yes"}.get(str(o.get("name", "")).lower())
                    if not side or o.get("price") is None:
                        continue
                    team = next((t for t in (g["home_team"], g["away_team"]) if (t, norm_name(name)) in players), None)
                    if team is None:
                        unmatched[name] = unmatched.get(name, 0) + 1
                        continue
                    hit = players[(team, norm_name(name))]
                    rows.append({"game_id": g["game_id"], "market": market, "player_id": hit[0], "player_name": hit[1], "team": team,
                                 "book": book, "side": side, "line": o.get("point"), "price": int(o["price"]),
                                 "updated": m.get("last_update") or b.get("last_update")})
    snap = {"season": season, "week": week, "fetched_at": utcnow(), "source": "The Odds API (the-odds-api.com), US books",
            "games": len(todo), "rows": rows, "unmatched_names": len(unmatched), "errors": errors, "credits_remaining": remaining}
    if not rows and errors:
        raise RuntimeError("The odds feed returned errors for every game (player props may not be included on this plan): "
                           + "; ".join(errors[:3]))
    odds_dir().mkdir(parents=True, exist_ok=True)
    snapshot_path(season, week).write_text(json.dumps(snap))
    log(f"odds: saved {len(rows)} prices from {len({r['book'] for r in rows})} books; {len(unmatched)} names unmatched; "
        f"{remaining} credits remaining")
    return snap


def maybe_fetch(c: sqlite3.Connection, season: int, log=print, force: bool = False, max_age_hours: float = 30) -> dict | None:
    """Fetch the upcoming week when a key is configured and the saved snapshot is missing or stale. Never raises."""
    key = os.environ.get("ODDS_API_KEY", "").strip()
    if not key:
        log("odds: ODDS_API_KEY not set; skipping (prices can still be typed in)")
        return None
    week = status.current_week(c, season)
    if not week:
        return None
    snap = load_snapshot(season, week)
    if os.environ.get("FG_ODDS_FETCH", "true").lower() not in ("1", "true") and not force:
        log("odds: fetching is off for this run (the hosted site fetches on Saturday); " +
            (f"using snapshot from {snap['fetched_at']}" if snap else "no snapshot for this week yet"))
        return snap
    if snap and not force:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(snap["fetched_at"])
        if age < timedelta(hours=max_age_hours):
            log(f"odds: keeping snapshot from {snap['fetched_at']} ({age.total_seconds() / 3600:.0f} h old)")
            return snap
    try:
        return fetch(c, season, week, key, log)
    except Exception as ex:  # noqa: BLE001 - odds are optional; the site still builds
        log(f"odds: not updated ({ex})")
        return snap


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    c = db.connect(paths.db_path())
    try:
        maybe_fetch(c, a.season, force=a.force)
    finally:
        c.close()


if __name__ == "__main__":
    main()
