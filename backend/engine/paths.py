from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE_VERSION = "fg-engine-1.0.0"


def data_dir() -> Path:
    return Path(os.environ.get("FG_DATA_DIR", REPO_ROOT / "data")).resolve()


def raw_dir() -> Path:
    return Path(os.environ.get("FG_RAW_DIR", data_dir() / "raw")).resolve()


def results_dir() -> Path:
    return data_dir() / "results"


def db_path() -> Path:
    return Path(os.environ.get("FG_DB", data_dir() / "fourth_and_goal.sqlite")).resolve()


def seed_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "seed" / "handoff"
