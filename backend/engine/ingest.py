"""Idempotent NFLverse CSV ingestion into SQLite.

Ported from the handoff `nfl_full_pbp_engine.py` with these corrections:
  * the week embargo is no longer hard-coded to season 2026 (it applies to whichever
    season is the current one);
  * a TD is credited to a receiver/rusher only when nflverse's `td_player_id` names that
    player (a teammate's fumble-recovery TD after a catch is not the receiver's TD);
  * SQL string literals use single quotes (double-quoted "now"/"pbp" fails when SQLite is
    compiled without DQS);
  * each file is imported in a single transaction and recorded with its SHA-256, so a
    re-run on an unchanged file is a no-op and a failed import leaves the previous
    data and `sources` row intact;
  * drives, offensive play counts, game ids, snaps, injuries and schedules are kept so
    later steps can compute red-zone drive rates, pace, participation and pregame lines.
"""
from __future__ import annotations

import sqlite3
import ssl
import time
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Callable

from . import sources
from .util import csv_reader, file_mtime_iso, nint, number, sha256_file, utcnow, value, yes

USER_AGENT = "FourthAndGoalAnalytics/1.0 (+nflverse CC-BY-4.0)"
OFFENSE_POS = ("QB", "RB", "WR", "TE", "FB")
Log = Callable[[str], None]


# --------------------------------------------------------------------------- download
def _ssl_context():
    """Use certifi's CA bundle when present (python.org macOS builds ship without system certs)."""
    try:
        import certifi  # noqa: PLC0415

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return None


def download(kind: str, season: int, data_dir: Path, log: Log = print, force: bool = False,
             max_age_hours: float | None = None) -> Path:
    """Fetch one release file. A cached file is reused unless forced or older than max_age_hours
    (used for the in-progress season so weekly updates arrive without re-downloading history)."""
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / sources.local_name(kind, season)
    url = sources.url_for(kind, season)
    fresh = path.exists() and (max_age_hours is None or (time.time() - path.stat().st_mtime) < max_age_hours * 3600)
    if path.exists() and path.stat().st_size > 10_000 and not force and fresh:
        log(f"Using cached {path.name} ({path.stat().st_size:,} bytes)")
        return path
    tmp = path.with_suffix(".download")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=180, context=_ssl_context()) as resp, open(tmp, "wb") as out:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
        if tmp.stat().st_size < 10_000:
            raise RuntimeError(f"download too small ({tmp.stat().st_size} bytes)")
        with open(tmp, "rb") as f:
            if f.read(64).lower().lstrip().startswith((b"<!doctype", b"<html")):
                raise RuntimeError("received HTML instead of CSV")
        tmp.replace(path)
        log(f"Downloaded {path.name}: {path.stat().st_size:,} bytes")
        return path
    except Exception as ex:  # noqa: BLE001 - surface any network failure as a clear message
        if tmp.exists():
            tmp.unlink()
        raise RuntimeError(f"Could not download {url} ({ex}). Place the CSV at {path} and re-run offline.") from ex


# --------------------------------------------------------------------------- parsers
def parse_pbp(row: dict, season: int, max_week: int | None = None, embargo_season: int | None = None):
    """Return a rush/target event tuple or None. Pure function; unit tested."""
    if value(row, "season_type", "game_type") not in ("REG", ""):
        return None
    week = nint(row.get("week"))
    if not week:
        return None
    if max_week is not None and (embargo_season is None or season == embargo_season) and week > max_week:
        return None
    if yes(row.get("no_play")) or yes(row.get("two_point_attempt")) or yes(row.get("qb_spike")):
        return None
    kind = value(row, "play_type")
    if kind not in ("pass", "run"):
        return None
    d = number(row.get("yardline_100"))
    if d is None or not 1 <= d <= 99:
        return None
    td_player = value(row, "td_player_id")
    if kind == "pass":
        pid = value(row, "receiver_player_id", "receiver_id")
        player = value(row, "receiver_player_name", "receiver")
        pos = value(row, "receiver_player_position")
        if not pid and not player:
            return None
        if value(row, "pass_attempt") and not yes(row.get("pass_attempt")):
            return None
        air = number(row.get("air_yards"))
        ez = 1 if air is not None and air >= d else 0
        flag = yes(row.get("pass_touchdown"))
        complete = 1 if yes(row.get("complete_pass")) else 0
    else:
        pid = value(row, "rusher_player_id", "rusher_id")
        player = value(row, "rusher_player_name", "rusher")
        pos = value(row, "rusher_player_position")
        if not pid and not player:
            return None
        if value(row, "rush_attempt") and not yes(row.get("rush_attempt")):
            return None
        air = None
        ez = 0
        flag = yes(row.get("rush_touchdown"))
        complete = 0
    td = int(flag and (not td_player or not pid or td_player == pid))
    game = value(row, "game_id")
    play = value(row, "play_id")
    if not game or not play:
        return None
    return (season, week, game, play, value(row, "posteam"), value(row, "defteam"), kind,
            pid if pid else "NAME:" + player, player, pos, d, air, complete, td, ez,
            1 if yes(row.get("qb_scramble")) else 0, value(row, "desc"))


def parse_player_stats(row: dict, season: int, max_week: int | None = None, embargo_season: int | None = None):
    if value(row, "season_type") not in ("REG", ""):
        return None
    week = nint(row.get("week"))
    if not week:
        return None
    if max_week is not None and (embargo_season is None or season == embargo_season) and week > max_week:
        return None
    pid = value(row, "player_id", "gsis_id")
    pos = value(row, "position")
    if not pid or pos not in OFFENSE_POS:
        return None
    return (season, week, value(row, "game_id"), pid, value(row, "player_display_name", "player_name"), pos,
            value(row, "team", "recent_team"), value(row, "opponent_team", "opponent"),
            nint(value(row, "carries", "rushing_attempts")), nint(row.get("targets")), nint(row.get("receptions")),
            nint(row.get("rushing_tds")), nint(row.get("receiving_tds")), nint(row.get("passing_tds")),
            number(row.get("rushing_yards"), 0.0), number(row.get("receiving_yards"), 0.0), value(row, "headshot_url"))


# --------------------------------------------------------------------------- importers
def _insert(c: sqlite3.Connection, table: str, rows: list[tuple]):
    if rows:
        c.executemany(f"INSERT OR REPLACE INTO {table} VALUES ({','.join('?' * len(rows[0]))})", rows)


def _stream(c, path, table, required, parse, batch_size=10_000):
    f, r = csv_reader(path)
    n = 0
    with f:
        missing = set(required) - set(r.fieldnames or [])
        if missing:
            raise ValueError(f"{Path(path).name} is missing required columns {sorted(missing)}")
        batch = []
        for line in r:
            t = parse(line)
            if t is None:
                continue
            batch.append(t)
            if len(batch) >= batch_size:
                _insert(c, table, batch)
                n += len(batch)
                batch.clear()
        _insert(c, table, batch)
        n += len(batch)
    return n


def import_pbp(c, path, season, max_week=None, embargo_season=None):
    c.execute("DELETE FROM pbp_events WHERE season=?", (season,))
    c.execute("DELETE FROM drives WHERE season=?", (season,))
    c.execute("DELETE FROM team_plays WHERE season=?", (season,))
    drives: dict = {}
    plays = defaultdict(lambda: [0, 0, 0.0])

    def parse(row):
        ev = parse_pbp(row, season, max_week, embargo_season)
        # Drive and pace bookkeeping uses every scrimmage play, not just named-player events.
        if value(row, "season_type", "game_type") in ("REG", "") and value(row, "posteam") and value(row, "game_id"):
            week = nint(row.get("week"))
            if week and not (max_week is not None and (embargo_season is None or season == embargo_season) and week > max_week):
                game, off = value(row, "game_id"), value(row, "posteam")
                drive = value(row, "fixed_drive", "drive")
                if drive:
                    key = (game, off, drive)
                    dr = drives.get(key)
                    if dr is None:
                        dr = drives[key] = [season, week, game, off, value(row, "defteam"), drive, 0, 0, "", 0]
                    if value(row, "play_type") in ("pass", "run") and not yes(row.get("no_play")):
                        dr[6] += 1
                    if yes(row.get("drive_inside20")) or (number(row.get("yardline_100"), 99) <= 20 and value(row, "play_type") in ("pass", "run")):
                        dr[7] = 1
                    res = value(row, "fixed_drive_result")
                    if res:
                        dr[8] = res
                        dr[9] = int(res == "Touchdown")
                if value(row, "play_type") in ("pass", "run") and not yes(row.get("no_play")) and not yes(row.get("two_point_attempt")):
                    p = plays[(game, off)]
                    p[0] = week
                    p[1] += 1
        return ev

    n = _stream(c, path, "pbp_events",
                {"season", "week", "game_id", "play_id", "posteam", "defteam", "play_type", "yardline_100"},
                lambda row: (lambda ev: ev + (None,) if ev else None)(parse(row)))
    _insert(c, "drives", [tuple(v) for v in drives.values()])
    _insert(c, "team_plays", [(season, v[0], g, o, v[1], None) for (g, o), v in plays.items()])
    return n


def import_stats(c, path, season, max_week=None, embargo_season=None):
    c.execute("DELETE FROM player_week WHERE season=?", (season,))
    return _stream(c, path, "player_week", {"week", "player_id"},
                   lambda row: parse_player_stats(row, season, max_week, embargo_season))


def import_roster(c, path, season, max_week=None, embargo_season=None):
    c.execute("DELETE FROM roster_week WHERE season=?", (season,))

    def parse(line):
        if value(line, "game_type") not in ("REG", ""):
            return None
        week = nint(line.get("week"))
        pid, team, pos = value(line, "gsis_id"), value(line, "team", "team_abbr"), value(line, "position")
        if not week or not pid or not team or pos not in OFFENSE_POS:
            return None
        # Rosters for the upcoming week are pregame information, so no embargo here.
        return (season, week, pid, value(line, "full_name", "player_name", "football_name"), pos,
                value(line, "depth_chart_position"), team, value(line, "status", "status_description_abbr"),
                value(line, "pfr_id"), value(line, "headshot_url"))

    return _stream(c, path, "roster_week", {"week", "gsis_id"}, parse)


def import_injuries(c, path, season, max_week=None, embargo_season=None):
    c.execute("DELETE FROM injuries WHERE season=?", (season,))

    def parse(line):
        if value(line, "game_type", "season_type") not in ("REG", ""):
            return None
        week = nint(line.get("week"))
        pid, pos = value(line, "gsis_id"), value(line, "position")
        if not week or not pid or pos not in OFFENSE_POS:
            return None
        return (season, week, value(line, "team"), pid, value(line, "full_name"), pos,
                value(line, "report_status"), value(line, "practice_status"),
                value(line, "report_primary_injury", "practice_primary_injury"))

    return _stream(c, path, "injuries", {"week", "gsis_id", "report_status"}, parse)


def import_snaps(c, path, season, max_week=None, embargo_season=None):
    c.execute("DELETE FROM snaps WHERE season=?", (season,))

    def parse(line):
        if value(line, "game_type") not in ("REG", ""):
            return None
        week = nint(line.get("week"))
        if not week or value(line, "position") not in OFFENSE_POS:
            return None
        if max_week is not None and (embargo_season is None or season == embargo_season) and week > max_week:
            return None
        return (season, week, value(line, "game_id"), value(line, "team"), value(line, "pfr_player_id"),
                value(line, "player"), value(line, "position"), nint(line.get("offense_snaps")),
                number(line.get("offense_pct"), 0.0))

    return _stream(c, path, "snaps", {"game_id", "pfr_player_id", "offense_snaps"}, parse)


def import_schedules(c, path, season=0, max_week=None, embargo_season=None, min_season=2023):
    c.execute("DELETE FROM games")

    def parse(line):
        s = nint(line.get("season"))
        if s < min_season or value(line, "game_type") != "REG":
            return None
        return (value(line, "game_id"), s, "REG", nint(line.get("week")), value(line, "gameday"),
                value(line, "gametime"), value(line, "away_team"), value(line, "home_team"),
                None if number(line.get("away_score")) is None else nint(line.get("away_score")),
                None if number(line.get("home_score")) is None else nint(line.get("home_score")),
                number(line.get("spread_line")), number(line.get("total_line")), value(line, "roof"))

    return _stream(c, path, "games", {"game_id", "season", "week", "home_team", "away_team"}, parse)


IMPORTERS = {"pbp": import_pbp, "stats": import_stats, "roster": import_roster,
             "injuries": import_injuries, "snaps": import_snaps, "schedules": import_schedules}


def import_file(c: sqlite3.Connection, kind: str, season: int, path: Path, *, force=False,
                max_week=None, embargo_season=None, log: Log = print) -> dict:
    """Import one file atomically. Returns a status dict. Unchanged files are skipped."""
    path = Path(path)
    url = sources.url_for(kind, season)
    if not path.exists():
        msg = f"Missing {path.name}"
        with c:
            prev = c.execute("SELECT status FROM sources WHERE kind=? AND season=?", (kind, season)).fetchone()
            if prev is None:
                c.execute("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (kind, season, path.name, url, None, None, None, 0, None, "missing", msg))
        return {"kind": kind, "season": season, "status": "missing", "message": msg}
    digest = sha256_file(path)
    prev = c.execute("SELECT sha256, status, rows_imported FROM sources WHERE kind=? AND season=?", (kind, season)).fetchone()
    if prev and prev["sha256"] == digest and prev["status"] == "ok" and not force:
        log(f"{path.name}: unchanged (sha256 {digest[:12]}), skipped")
        return {"kind": kind, "season": season, "status": "unchanged", "rows": prev["rows_imported"]}
    try:
        with c:  # one transaction: delete + insert + sources row, or nothing
            rows = IMPORTERS[kind](c, path, season, max_week, embargo_season)
            c.execute("INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (kind, season, path.name, url, digest, path.stat().st_size, file_mtime_iso(path),
                       rows, utcnow(), "ok", ""))
        log(f"Imported {path.name}: {rows:,} rows")
        return {"kind": kind, "season": season, "status": "ok", "rows": rows}
    except Exception as ex:  # noqa: BLE001
        with c:
            if prev is None:
                c.execute("INSERT OR REPLACE INTO sources VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (kind, season, path.name, url, None, path.stat().st_size, file_mtime_iso(path),
                           0, utcnow(), "error", str(ex)[:500]))
            else:
                c.execute("UPDATE sources SET message=? WHERE kind=? AND season=?",
                          (f"Last import attempt failed ({utcnow()}): {ex}"[:500], kind, season))
        log(f"IMPORT ERROR {path.name}: {ex}")
        return {"kind": kind, "season": season, "status": "error", "message": str(ex)}
