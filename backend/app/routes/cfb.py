"""College football pages read the JSON files written by `python -m cfb.pipeline`; the desktop app serves them here
unchanged."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/cfb", tags=["cfb"])
SITE = (Path(__file__).resolve().parents[3] / "site-data" / "cfb").resolve()


@router.get("/{path:path}")
def cfb_file(path: str):
    f = (SITE / path).resolve()
    if SITE not in f.parents or f.suffix != ".json" or not f.is_file():
        raise HTTPException(404, "College football data not built yet: run python -m cfb.pipeline")
    return FileResponse(f, media_type="application/json")
