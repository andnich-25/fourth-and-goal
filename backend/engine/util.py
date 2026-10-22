"""Small parsing helpers shared by the importer (ported from the handoff engine)."""
from __future__ import annotations

import csv
import gzip
import hashlib
from datetime import datetime, timezone
from pathlib import Path

NULLS = ("", "na", "nan", "null", "none")


def number(v, default=None):
    try:
        if v is None or str(v).strip().lower() in NULLS:
            return default
        return float(v)
    except (ValueError, TypeError):
        return default


def nint(v) -> int:
    n = number(v)
    return int(n) if n is not None else 0


def yes(v) -> bool:
    return str(v).strip().lower() in ("1", "1.0", "true", "t", "yes")


def value(row: dict, *keys: str) -> str:
    for k in keys:
        v = row.get(k)
        if v is not None and str(v).strip() and str(v).strip().lower() not in NULLS:
            return str(v).strip()
    return ""


# Relocated or renamed franchises map to today's code so a team's history stays continuous.
TEAM_ALIASES = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "JAC": "JAX", "WSH": "WAS"}


def team(row: dict, *keys: str) -> str:
    v = value(row, *keys)
    return TEAM_ALIASES.get(v, v)


def csv_reader(path):
    handler = gzip.open if str(path).endswith(".gz") else open
    f = handler(path, "rt", newline="", encoding="utf-8-sig")
    return f, csv.DictReader(f)


def sha256_file(path, chunk: int = 4 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def file_mtime_iso(path) -> str:
    return datetime.fromtimestamp(Path(path).stat().st_mtime, timezone.utc).replace(microsecond=0).isoformat()
