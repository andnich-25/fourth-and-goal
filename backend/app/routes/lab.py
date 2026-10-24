"""The Lab's top 10 reads the board written by `scripts/lab-picks.ts` (frontend); the desktop app serves it here
unchanged."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/lab", tags=["lab"])
SITE = (Path(__file__).resolve().parents[3] / "site-data" / "lab").resolve()


@router.get("/{path:path}")
def lab_file(path: str):
    f = (SITE / path).resolve()
    if SITE not in f.parents or f.suffix != ".json" or not f.is_file():
        raise HTTPException(404, "The Lab's picks are not built yet: run npx vite-node scripts/lab-picks.ts in frontend")
    return FileResponse(f, media_type="application/json")
