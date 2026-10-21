"""Shared helpers for API routes: DB connection, run lookup, odds math."""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator

from fastapi import HTTPException

from engine import db, paths


def get_db() -> Iterator[sqlite3.Connection]:
    c = db.connect(paths.db_path())
    try:
        yield c
    finally:
        c.close()


def prediction_run(c: sqlite3.Connection, season: int, week: int):
    return c.execute("SELECT * FROM model_runs WHERE kind='prediction' AND season=? AND week=? ORDER BY created_at DESC LIMIT 1",
                     (season, week)).fetchone()


def latest_walk_forward(c: sqlite3.Connection):
    return c.execute("SELECT * FROM model_runs WHERE kind='walk_forward' ORDER BY created_at DESC LIMIT 1").fetchone()


def default_season_week(c: sqlite3.Connection) -> tuple[int, int]:
    from engine import status

    s = status.latest_season(c) or 2026
    return s, status.current_week(c, s) or 1


def implied_probability(odds: str | None, fmt: str | None) -> float | None:
    """Convert manual odds to the bookmaker-implied probability (includes the margin/vig)."""
    if odds is None or str(odds).strip() == "":
        return None
    s = str(odds).strip().replace(" ", "")
    try:
        if fmt == "decimal" or (fmt is None and "." in s and not s.startswith(("+", "-"))):
            d = float(s)
            if d <= 1.0:
                raise ValueError
            return 1.0 / d
        a = float(s)
        if -100 < a < 100:
            raise ValueError
        return 100.0 / (a + 100.0) if a > 0 else -a / (-a + 100.0)
    except ValueError as ex:
        raise HTTPException(422, f"Could not read odds '{odds}'. Use American (+150 / -120) or decimal (2.50).") from ex


def row_to_dict(r: sqlite3.Row | None) -> dict | None:
    return dict(r) if r is not None else None


def loads(s, default=None):
    try:
        return json.loads(s) if s else default
    except (TypeError, json.JSONDecodeError):
        return default
