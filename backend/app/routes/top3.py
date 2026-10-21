from __future__ import annotations

import csv
import io
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from engine import predict
from engine.util import utcnow

from ..core import default_season_week, get_db, implied_probability, loads, prediction_run
from ..schemas import LockRequest

router = APIRouter(prefix="/api", tags=["top3"])
ET = ZoneInfo("America/New_York")
JOINT_NOTE = ("Simplistic independence product of the individual validated estimates. It ignores correlation between legs "
              "(game script, weather, shared scoring environment) and was not separately validated as a parlay probability.")


def kickoff_utc(gameday: str | None, gametime: str | None) -> datetime | None:
    if not gameday:
        return None
    try:
        dt = datetime.strptime(f"{gameday} {gametime or '13:00'}", "%Y-%m-%d %H:%M").replace(tzinfo=ET)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


@router.get("/weekly-top3")
def weekly_top3(season: int | None = None, week: int | None = None, exclude: list[str] = Query(default=[]),
                c: sqlite3.Connection = Depends(get_db)):
    ds, dw = default_season_week(c)
    season, week = season or ds, week or dw
    run = prediction_run(c, season, week)
    if run is None:
        return {"season": season, "week": week, "legs": [], "calibrated": False, "run_id": None, "model_version": None,
                "empty_reason": "No league-wide prediction run for this week yet. Load data on the Data page.",
                "rules": predict.rules(False)}
    res = predict.top3(c, run["run_id"], set(exclude))
    for leg in res["legs"] + res.get("alternates", []):
        g = c.execute("SELECT gameday, gametime FROM games WHERE game_id=?", (leg["game_id"],)).fetchone()
        ko = kickoff_utc(g["gameday"], g["gametime"]) if g else None
        leg["kickoff_utc"] = ko.isoformat() if ko else None
        leg["started"] = bool(ko and ko <= datetime.now(timezone.utc))
    calibrated = res["calibrated"]
    joint = None
    if calibrated and res["legs"] and all(l["p_model"] is not None for l in res["legs"]):
        prod = 1.0
        for l in res["legs"]:
            prod *= l["p_model"]
        joint = {"value": prod, "method": "independence product", "note": JOINT_NOTE}
    wf = c.execute("SELECT metrics FROM model_runs WHERE run_id=?", (loads(run["metrics"], {}).get("walk_forward_run"),)).fetchone()
    history = None
    if wf:
        m = loads(wf["metrics"], {})
        history = (m.get("topn", {}).get(run["model_version"], {}) or {}).get("top3_policy")
    return {"season": season, "week": week, "run_id": run["run_id"], "model_version": run["model_version"],
            "calibrated": calibrated, "data_cutoff": run["data_cutoff"], "as_of": run["created_at"], "joint": joint,
            "walk_forward_top3_policy": history, **res}


@router.post("/weekly-top3/lock", status_code=201)
def lock(req: LockRequest, c: sqlite3.Connection = Depends(get_db)):
    """Freeze a pregame selection for later audit. Locked rows can never be edited or deleted."""
    run = prediction_run(c, req.season, req.week)
    if run is None:
        raise HTTPException(409, "No prediction run exists for that week.")
    if len({l.player_id for l in req.legs}) != len(req.legs):
        raise HTTPException(422, "Duplicate player in selection.")
    calibrated = bool(run["calibrated"])
    legs, games = [], set()
    now = datetime.now(timezone.utc)
    for l in req.legs:
        p = c.execute("SELECT * FROM predictions WHERE run_id=? AND player_id=? AND team=?", (run["run_id"], l.player_id, l.team)).fetchone()
        if p is None:
            raise HTTPException(422, f"{l.player_id} is not in the {req.season} Week {req.week} candidate pool.")
        if not p["eligible"]:
            raise HTTPException(422, f"{p['player_name']} is not eligible: {p['exclusion']}")
        g = c.execute("SELECT gameday, gametime FROM games WHERE game_id=?", (p["game_id"],)).fetchone()
        ko = kickoff_utc(g["gameday"], g["gametime"]) if g else None
        if ko is None or ko <= now:
            raise HTTPException(409, f"{p['player_name']}'s game has started or has no kickoff time; locks are pregame only.")
        if p["game_id"] in games:
            raise HTTPException(422, "Two legs from the same game: same-game outcomes are correlated, pick one per game.")
        games.add(p["game_id"])
        implied = implied_probability(l.odds, l.odds_format)
        f = loads(p["features"], {})
        legs.append({"player_id": p["player_id"], "player_name": p["player_name"], "team": p["team"], "opponent": p["opponent"],
                     "position": p["position"], "game_id": p["game_id"], "kickoff_utc": ko.isoformat(), "rank": p["rank"],
                     "score": p["score"], "p_model": p["p_model"] if calibrated else None, "confidence": p["confidence"],
                     "flags": loads(p["flags"], []), "reasons": f.get("reasons", []), "odds_input": l.odds,
                     "odds_format": l.odds_format, "implied_market_prob": implied,
                     "edge_vs_market": (p["p_model"] - implied) if calibrated and implied is not None and p["p_model"] is not None else None})
    lock_id = "lock-" + uuid.uuid4().hex[:10]
    with c:
        c.execute("INSERT INTO top3_locks VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (lock_id, utcnow(), req.season, req.week, run["run_id"], run["model_version"], int(calibrated),
                   run["data_cutoff"], json.dumps(legs), req.note))
    return {"lock_id": lock_id, "legs": legs}


def _audit(c, lk) -> dict:
    legs = loads(lk["legs"], [])
    graded = []
    for l in legs:
        g = c.execute("SELECT home_score FROM games WHERE game_id=?", (l["game_id"],)).fetchone()
        done = g is not None and g["home_score"] is not None
        pg = c.execute("SELECT participated, scored_anytime, anytime_tds FROM player_game WHERE season=? AND week=? AND player_id=?",
                       (lk["season"], lk["week"], l["player_id"])).fetchone()
        if not done:
            res = "pending"
        elif pg is None or not pg["participated"]:
            res = "void (did not play)"
        else:
            res = "hit" if pg["scored_anytime"] else "miss"
        graded.append(l | {"result": res, "touchdowns": pg["anytime_tds"] if pg and done else None})
    results = [l["result"] for l in graded]
    return {"lock_id": lk["lock_id"], "created_at": lk["created_at"], "season": lk["season"], "week": lk["week"],
            "run_id": lk["run_id"], "model_version": lk["model_version"], "calibrated": bool(lk["calibrated"]),
            "data_cutoff": lk["data_cutoff"], "note": lk["note"], "legs": graded,
            "summary": {"hits": results.count("hit"), "misses": results.count("miss"), "pending": results.count("pending"),
                        "voids": sum(r.startswith("void") for r in results),
                        "all_hit": (results.count("hit") == len(results)) if "pending" not in results and results else None}}


@router.get("/locks")
def locks(season: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    q = "SELECT * FROM top3_locks" + (" WHERE season=?" if season else "") + " ORDER BY created_at DESC"
    return [_audit(c, r) for r in c.execute(q, (season,) if season else ())]


@router.get("/export/locks.csv")
def export_locks(c: sqlite3.Connection = Depends(get_db)):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["lock_id", "locked_at_utc", "season", "week", "model_version", "calibrated", "data_cutoff", "player", "team",
                "position", "opponent", "kickoff_utc", "rank", "research_score", "validated_p", "odds_input", "implied_market_prob",
                "result", "touchdowns", "note"])
    for r in c.execute("SELECT * FROM top3_locks ORDER BY created_at"):
        a = _audit(c, r)
        for l in a["legs"]:
            w.writerow([a["lock_id"], a["created_at"], a["season"], a["week"], a["model_version"], a["calibrated"], a["data_cutoff"],
                        l["player_name"], l["team"], l["position"], l["opponent"], l["kickoff_utc"], l["rank"], l["score"],
                        l["p_model"] if a["calibrated"] else "", l["odds_input"] or "", l["implied_market_prob"] or "", l["result"],
                        "" if l["touchdowns"] is None else l["touchdowns"], a["note"] or ""])
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="fourth-and-goal-locked-selections.csv"'})


@router.get("/odds/implied")
def odds(odds: str, fmt: str | None = None):
    return {"odds": odds, "implied_probability": implied_probability(odds, fmt),
            "note": "Bookmaker-implied probability includes the bookmaker margin (vig)."}
