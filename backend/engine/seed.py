"""Load the handoff's PILOT tables and the Week 7 Venom screenshot transcription.

The 26-player pilot is biased and is stored in `pilot_*` tables only; nothing in the
league-wide pipeline reads from them. Venom rows are tagged with the week they were
observed and are never projected backward.
"""
from __future__ import annotations

import csv
import io
import sqlite3
import uuid

import pandas as pd

from . import paths
from .util import number, utcnow

PILOT_FILES = {
    "pilot_player_games": "nfl_2026_verified_pilot_player_games.csv",
    "pilot_walk_forward": "nfl_2026_walk_forward_pilot_backtest.csv",
    "pilot_week7_candidates": "nfl_2026_week7_pilot_candidates.csv",
    "pilot_policy_metrics": "nfl_v11_backtest_policy_metrics.csv",
    "pilot_week7_watchlist": "nfl_v11_week7_opportunity_watchlist.csv",
}
VENOM_REQUIRED = {"player_name", "team", "position", "opponent", "venom_score", "observed_date"}


def seed_pilot(c: sqlite3.Connection) -> dict:
    out = {}
    for table, fn in PILOT_FILES.items():
        p = paths.seed_dir() / fn
        if p.exists():
            df = pd.read_csv(p)
            df.to_sql(table, c, if_exists="replace", index=False)
            out[table] = len(df)
    c.commit()
    return out


def import_venom_csv(c: sqlite3.Connection, text: str, season: int, week: int, source: str = "manual upload") -> dict:
    """Validate and store screenshot-derived Venom rows for one week. Returns counts and errors."""
    reader = csv.DictReader(io.StringIO(text))
    cols = set(reader.fieldnames or [])
    missing = VENOM_REQUIRED - cols
    if missing:
        return {"ok": False, "errors": [f"Missing columns: {', '.join(sorted(missing))}"], "inserted": 0}
    batch = "venom-" + uuid.uuid4().hex[:8]
    rows, errors = [], []
    for i, r in enumerate(reader, start=2):
        name = (r.get("player_name") or "").strip()
        score = number(r.get("venom_score"))
        prob = number(r.get("venom_anytime_td_probability"))
        if not name:
            errors.append(f"Line {i}: player_name is empty")
            continue
        if score is not None and not 0 <= score <= 100:
            errors.append(f"Line {i}: venom_score {score} outside 0-100")
            continue
        if prob is not None and prob > 1:
            prob = prob / 100.0 if prob <= 100 else None
        rows.append((batch, utcnow(), (r.get("observed_date") or "").strip(), season, week, name,
                     (r.get("team") or "").strip().upper(), (r.get("position") or "").strip().upper(),
                     (r.get("opponent") or "").strip().upper(), int(number(r.get("venom_rank"), 0) or 0) or None,
                     score, prob, (r.get("source_notes") or source).strip()))
    if errors and not rows:
        return {"ok": False, "errors": errors, "inserted": 0}
    with c:
        c.executemany("""INSERT INTO venom_observations(batch_id, imported_at, observed_date, season, week, player_name, team,
                         position, opponent, venom_rank, venom_score, venom_prob, source_notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                         ON CONFLICT(season, week, player_name, team, observed_date) DO UPDATE SET
                         venom_rank=excluded.venom_rank, venom_score=excluded.venom_score, venom_prob=excluded.venom_prob,
                         source_notes=excluded.source_notes, batch_id=excluded.batch_id, imported_at=excluded.imported_at""", rows)
    return {"ok": True, "errors": errors, "inserted": len(rows), "batch_id": batch}


def seed_venom(c: sqlite3.Connection) -> dict:
    res = {}
    p = paths.seed_dir() / "venom_snapshot_week7_from_user_screenshots.csv"
    if p.exists() and not c.execute("SELECT 1 FROM venom_observations WHERE season=2026 AND week=7 LIMIT 1").fetchone():
        res["players"] = import_venom_csv(c, p.read_text(), 2026, 7, "Week 7 screenshot (handoff transcription)")
    d = paths.seed_dir() / "venom_defensive_notes_week7.csv"
    if d.exists():
        df = pd.read_csv(d)
        with c:
            for r in df.itertuples(index=False):
                c.execute("""INSERT OR IGNORE INTO venom_defense_notes(batch_id, imported_at, season, week, defense, sample_games,
                             stat, value, source) VALUES (?,?,?,?,?,?,?,?,?)""",
                          ("handoff-seed", utcnow(), 2026, 7, r.defense, int(r.sample_games), r.stat, float(r.value), r.source))
        res["defense_notes"] = len(df)
    return res
