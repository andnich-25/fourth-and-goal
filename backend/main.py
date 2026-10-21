"""Fourth & Goal Analytics API.  Run: uvicorn main:app --reload  (from backend/)."""
from __future__ import annotations

import os
from pathlib import Path

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.routes import backtest, data, defenses, overview, players, rankings, top3, venom
from engine import db, paths, seed


@asynccontextmanager
async def lifespan(_app):
    c = db.connect(paths.db_path())
    try:
        seed.seed_pilot(c)
        seed.seed_venom(c)
    finally:
        c.close()
    yield


app = FastAPI(lifespan=lifespan, title="Fourth & Goal Analytics API", version=paths.ENGINE_VERSION,
              description="Local-first NFL anytime-TD research API. Probabilities appear only after walk-forward validation.")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("FG_CORS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
                   allow_methods=["*"], allow_headers=["*"])

for r in (data.router, rankings.router, players.router, defenses.router, top3.router, backtest.router, venom.router, overview.router):
    app.include_router(r)


# Serve the built frontend (npm run build) from the same origin when present.
DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
