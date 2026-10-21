from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from engine import seed

from ..core import get_db
from ..schemas import VenomImport

router = APIRouter(prefix="/api/venom", tags=["venom"])


@router.post("/manual-import")
def manual_import(req: VenomImport, c: sqlite3.Connection = Depends(get_db)):
    """Store screenshot-derived Venom observations for ONE week. They are never applied to other weeks."""
    if not 1 <= req.week <= 22:
        raise HTTPException(422, "week must be 1-22")
    res = seed.import_venom_csv(c, req.csv_text, req.season, req.week)
    if not res["ok"]:
        raise HTTPException(422, {"errors": res["errors"]})
    return res


@router.get("")
def list_obs(season: int | None = None, week: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    q, p = "SELECT * FROM venom_observations WHERE 1=1", []
    if season:
        q += " AND season=?"
        p.append(season)
    if week:
        q += " AND week=?"
        p.append(week)
    rows = [dict(r) for r in c.execute(q + " ORDER BY season, week, venom_rank", p)]
    notes = [dict(r) for r in c.execute("SELECT * FROM venom_defense_notes ORDER BY season, week, defense")]
    return {"observations": rows, "defense_notes": notes,
            "note": "User-supplied screenshot transcriptions. Venom Score is a ranking number, not a probability; these values are "
                    "not odds and not part of model training or backtests.",
            "template_columns": sorted(seed.VENOM_REQUIRED | {"venom_rank", "venom_anytime_td_probability", "source_notes"})}
