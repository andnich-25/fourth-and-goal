"""NBA pages read the JSON files written by `python -m nba.pipeline`; the desktop app serves them here unchanged."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/nba", tags=["nba"])
SITE = (Path(__file__).resolve().parents[3] / "site-data" / "nba").resolve()


@router.get("/{path:path}")
def nba_file(path: str):
    f = (SITE / path).resolve()
    if SITE not in f.parents or f.suffix != ".json" or not f.is_file():
        raise HTTPException(404, "NBA data not built yet: run python -m nba.pipeline")
    return FileResponse(f, media_type="application/json")
