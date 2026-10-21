from __future__ import annotations

import csv
import io
import sqlite3

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from engine import status

from ..core import default_season_week, get_db, loads, prediction_run
from ..schemas import RankingRow, RankingsResponse

router = APIRouter(prefix="/api", tags=["rankings"])

FEATURE_SORTS = {"carries_pg", "targets_pg", "rz_carries_pg", "goal5_carries_pg", "goal10_carries_pg", "rz_targets_pg",
                 "goal10_targets_pg", "ez_proxy_pg", "xtd_pg", "td_pg", "xtd_share", "snap_pct", "team_implied_total",
                 "opp_def_pos_td_pg", "opp_def_pos_mult", "n_games_cur", "cur_tds", "cur_xtd"}
COLUMN_SORTS = {"rank": "rank", "score": "score", "p_model": "p_model", "player_name": "player_name", "team": "team",
                "position": "position", "opponent": "opponent"}


def _query(c, run_id, position, team, search, eligible_only, sort, order, calibrated):
    where, params = ["p.run_id=?"], [run_id]
    if position:
        where.append(f"p.position IN ({','.join('?'*len(position))})")
        params += position
    if team:
        where.append("(p.team=? OR p.opponent=?)")
        params += [team, team]
    if search:
        where.append("p.player_name LIKE ?")
        params.append(f"%{search}%")
    if eligible_only:
        where.append("p.eligible=1")
    if sort == "p_model" and not calibrated:
        sort = "rank"
    if sort in COLUMN_SORTS:
        expr = f"p.{COLUMN_SORTS[sort]}"
    elif sort in FEATURE_SORTS:
        expr = f"json_extract(p.features, '$.{sort}')"
    else:
        expr = "p.rank"
    direction = "ASC" if order == "asc" else "DESC"
    if sort in ("rank", None) and order != "desc":
        direction = "ASC"
    # Unavailable values sort last instead of being treated as zero.
    order_sql = f"({expr} IS NULL), {expr} {direction}, p.rank IS NULL, p.rank ASC"
    return " AND ".join(where), params, order_sql


def _venom(c, season, week):
    try:
        return {(r["player_name"], r["team"]): dict(r) for r in
                c.execute("SELECT * FROM venom_observations WHERE season=? AND week=?", (season, week))}
    except sqlite3.OperationalError:
        return {}


def _row(r, calibrated, venom) -> RankingRow:
    f = loads(r["features"], {})
    v = venom.get((r["player_name"], r["team"]))
    return RankingRow(rank=r["rank"], player_id=r["player_id"], player_name=r["player_name"], team=r["team"],
                      position=r["position"], opponent=r["opponent"], game_id=r["game_id"], gameday=f.get("gameday"),
                      gametime=f.get("gametime"), is_home=f.get("is_home"), eligible=bool(r["eligible"]), exclusion=r["exclusion"],
                      score=r["score"], p_model=r["p_model"] if calibrated else None, confidence=r["confidence"],
                      flags=loads(r["flags"], []), reasons=f.pop("reasons", []) or [], features=f,
                      venom_score=v["venom_score"] if v else None, venom_prob=v["venom_prob"] if v else None,
                      outcome=r["outcome"], participated=r["participated"])


@router.get("/rankings", response_model=RankingsResponse)
def rankings(season: int | None = None, week: int | None = None, position: list[str] = Query(default=[]),
             team: str | None = None, search: str | None = None, eligible_only: bool = True, sort: str = "rank",
             order: str = "asc", page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=2000),
             c: sqlite3.Connection = Depends(get_db)):
    ds, dw = default_season_week(c)
    season, week = season or ds, week or dw
    run = prediction_run(c, season, week)
    st = status.read_build_status() or {}
    if run is None:
        reason = ("No full-league predictions exist yet: the nflverse import has not been run." if not st.get("data_loaded")
                  else f"No prediction run for {season} Week {week}. Data gates may not pass for this week.")
        return RankingsResponse(season=season, week=week, run_id=None, model_version=None, calibrated=False, as_of=None,
                                data_cutoff=None, total=0, page=page, page_size=page_size, rows=[],
                                fields_available={}, empty_reason=reason)
    calibrated = bool(run["calibrated"])
    where, params, order_sql = _query(c, run["run_id"], [p.upper() for p in position], team, search, eligible_only, sort, order, calibrated)
    total = c.execute(f"SELECT COUNT(*) FROM predictions p WHERE {where}", params).fetchone()[0]
    rows = c.execute(f"SELECT * FROM predictions p WHERE {where} ORDER BY {order_sql} LIMIT ? OFFSET ?",
                     params + [page_size, (page - 1) * page_size]).fetchall()
    venom = _venom(c, season, week)
    snaps = c.execute("SELECT COUNT(*) FROM snaps WHERE season=?", (season,)).fetchone()[0]
    inj = c.execute("SELECT COUNT(*) FROM injuries WHERE season=? AND week=?", (season, week)).fetchone()[0]
    return RankingsResponse(
        season=season, week=week, run_id=run["run_id"], model_version=run["model_version"], calibrated=calibrated,
        as_of=run["created_at"], data_cutoff=run["data_cutoff"], total=total, page=page, page_size=page_size,
        rows=[_row(r, calibrated, venom) for r in rows],
        fields_available={"p_model": calibrated, "venom": bool(venom), "snap_pct": snaps > 0, "injury_report": inj > 0,
                          "market_lines": c.execute("SELECT COUNT(*) FROM games WHERE season=? AND week=? AND total_line IS NOT NULL",
                                                    (season, week)).fetchone()[0] > 0,
                          "coverage": False, "outcomes": any(r["outcome"] is not None for r in rows)})


@router.get("/export/rankings.csv")
def export_rankings(season: int | None = None, week: int | None = None, c: sqlite3.Connection = Depends(get_db)):
    ds, dw = default_season_week(c)
    season, week = season or ds, week or dw
    run = prediction_run(c, season, week)
    buf = io.StringIO()
    w = csv.writer(buf)
    cols = ["rank", "player", "team", "position", "opponent", "eligible", "exclusion", "research_score", "validated_p_anytime_td",
            "confidence", "flags", "rz_carries_pg", "goal5_carries_pg", "rz_targets_pg", "ez_target_proxy_pg", "xtd_pg",
            "xtd_share", "team_implied_total", "opp_def_pos_td_pg", "model_version", "calibrated", "data_cutoff", "run_id", "generated_at"]
    w.writerow(cols)
    if run is not None:
        calibrated = bool(run["calibrated"])
        for r in c.execute("SELECT * FROM predictions WHERE run_id=? ORDER BY rank IS NULL, rank", (run["run_id"],)):
            f = loads(r["features"], {})
            w.writerow([r["rank"], r["player_name"], r["team"], r["position"], r["opponent"], r["eligible"], r["exclusion"] or "",
                        r["score"], r["p_model"] if calibrated else "", r["confidence"], "; ".join(loads(r["flags"], [])),
                        f.get("rz_carries_pg"), f.get("goal5_carries_pg"), f.get("rz_targets_pg"), f.get("ez_proxy_pg"), f.get("xtd_pg"),
                        f.get("xtd_share"), f.get("team_implied_total"), f.get("opp_def_pos_td_pg"), run["model_version"],
                        calibrated, run["data_cutoff"], run["run_id"], run["created_at"]])
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="fourth-and-goal-rankings-{season}-w{week}.csv"'})


@router.get("/feature-glossary")
def glossary():
    from engine.features import FEATURE_DOC

    return FEATURE_DOC | {"score": "Research score: percentile rank among eligible players (0-100). Not a probability.",
                          "p_model": "Validated probability of 1+ rushing or receiving TD in the game (shown only after the promotion gate passes)."}
