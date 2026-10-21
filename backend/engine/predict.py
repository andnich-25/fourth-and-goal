"""Weekly candidate board: eligibility, ranking, evidence strings, and the Top 3 shortlist."""
from __future__ import annotations

import json
import sqlite3
import uuid

import numpy as np
import pandas as pd

from . import backtest, models
from .util import utcnow

POSITIONS = ("QB", "RB", "WR", "TE")
TOP3_MIN_P = 0.30  # evidence floor for a leg when probabilities are validated
TOP3_MIN_PCTL = 90.0  # evidence floor (research score percentile) when they are not


def latest_gate(c: sqlite3.Connection) -> dict | None:
    r = c.execute("SELECT run_id, gate, created_at FROM model_runs WHERE kind='walk_forward' ORDER BY created_at DESC LIMIT 1").fetchone()
    if not r:
        return None
    g = json.loads(r["gate"])
    g["run_id"] = r["run_id"]
    g["created_at"] = r["created_at"]
    return g


def data_cutoff(c, season, week) -> str | None:
    r = c.execute("SELECT MAX(gameday) FROM games WHERE season=? AND week<? AND home_score IS NOT NULL", (season, week)).fetchone()
    return r[0] if r else None


def predict_week(c: sqlite3.Connection, feats: pd.DataFrame, season: int, week: int, gate: dict | None, log=print) -> dict:
    labeled = feats[(feats.participated == 1) & (feats.has_history == 1) & feats.scored_anytime.notna()
                    & feats.position.isin(POSITIONS)].copy()
    labeled["scored_anytime"] = labeled.scored_anytime.astype(int)
    train = labeled[(labeled.season < season) | ((labeled.season == season) & (labeled.week < week))]
    rows = feats[(feats.season == season) & (feats.week == week) & feats.position.isin(POSITIONS)].copy()
    if rows.empty or len(train) < 1500:
        raise RuntimeError(f"Cannot score {season} W{week}: {len(rows)} candidates, {len(train)} training rows")
    tg = pd.read_sql_query("SELECT season, week, offensive_tds, implied_total FROM team_game WHERE season<? OR (season=? AND week<?)",
                           c, params=(season, season, week))
    struct = models.StructuralModel().fit(train, tg)
    rows["lam"] = struct.lam(rows)
    promoted = (gate or {}).get("promoted")
    calibrated = promoted is not None
    if calibrated:
        model = models.CANDIDATES[promoted]().fit(train, tg)
        rows["p_model"] = model.predict(rows)
        rank_col = "p_model"
        version = promoted
        params = model.params()
    else:
        rows["p_model"] = np.nan  # never shown: model not validated
        rank_col = "lam"
        version = struct.version + " (research rank only)"
        params = struct.params()

    # Eligibility (pregame information only).
    rep = rows.report_status.fillna("")
    excl = np.select(
        [rows.has_history.ne(1), rows.status.ne("ACT"), rep.eq("Out")],
        ["No earlier game in the data window", "Roster status " + rows.status.fillna("unknown").astype(str), "Ruled Out on injury report"],
        default="")
    rows["exclusion"] = excl
    rows["eligible"] = (rows.exclusion == "").astype(int)
    el = rows.eligible == 1
    rows["score"] = np.nan
    rows.loc[el, "score"] = rows.loc[el, rank_col].rank(pct=True) * 100
    rows["rank"] = np.nan
    rows.loc[el, "rank"] = rows.loc[el, rank_col].rank(ascending=False, method="first")
    rows["confidence"] = np.select(
        [(rows.n_games_cur >= 4) & rows.changed_team.eq(0) & rows.snap_pct.notna(),
         (rows.n_games_cur >= 2) | (rows.n_games_window >= 4)], ["High", "Medium"], default="Low")
    rows["flags"] = rows.apply(_flags, axis=1)
    rows["reasons"] = rows.apply(_reasons, axis=1)

    run_id = "pr-" + uuid.uuid4().hex[:10]
    cutoff = data_cutoff(c, season, week)
    feature_cols = [k for k in ("n_games_cur", "n_games_window", "carries_pg", "targets_pg", "rz_carries_pg", "goal10_carries_pg",
                                "goal5_carries_pg", "rz_targets_pg", "goal10_targets_pg", "ez_proxy_pg", "xtd_pg", "td_pg", "xtd_share",
                                "opp_share", "snap_pct", "anytime_rate_shrunk", "team_implied_total", "team_td_pg", "opp_def_pos_td_pg",
                                "opp_def_pos_td_pg_raw", "opp_def_pos_mult", "opp_def_pos_xtd_mult", "opp_def_games", "opp_def_pos_tds",
                                "league_pos_td_pg", "changed_team", "missed_team_games", "cur_tds", "cur_xtd", "is_home", "gameday",
                                "gametime", "report_status", "practice_status", "injury", "injury_report_published", "status",
                                "last_game_week") if k in rows]
    out = []
    for r in rows.itertuples(index=False):
        f = {k: _clean(getattr(r, k)) for k in feature_cols}
        f["reasons"] = r.reasons
        outcome = None if r.scored_anytime != r.scored_anytime else int(r.scored_anytime)
        out.append((run_id, int(season), int(week), r.game_id, r.player_id, r.player_name, r.position, r.team, r.opponent,
                    int(r.eligible), r.exclusion or None, json.dumps(r.flags), json.dumps(f), float(r.lam),
                    None if not calibrated else float(r.p_model), _clean(r.score), None if r.rank != r.rank else int(r.rank),
                    r.confidence, outcome if r.game_completed == 1 else None, int(r.participated) if r.game_completed == 1 else None))
    with c:
        c.execute("INSERT INTO model_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (run_id, "prediction", version, utcnow(), int(season), int(week), cutoff, None,
                   json.dumps(params, default=float), json.dumps({"train_rows": int(len(train)), "candidates": int(len(rows)),
                                                                  "eligible": int(el.sum()), "walk_forward_run": (gate or {}).get("run_id")}),
                   json.dumps({"promoted": promoted}), 1 if calibrated else 0, 1 if calibrated else 0))
        c.executemany("INSERT INTO predictions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", out)
    log(f"predictions {season} W{week}: {int(el.sum())} eligible of {len(rows)} ({version}, calibrated={calibrated})")
    return {"run_id": run_id, "season": season, "week": week, "calibrated": calibrated, "model_version": version}


def _clean(v):
    if v is None:
        return None
    if isinstance(v, (float, np.floating)):
        return None if np.isnan(v) else round(float(v), 5)
    if isinstance(v, (np.integer,)):
        return int(v)
    return v


def _flags(r) -> list[str]:
    f = []
    rep = r.report_status if isinstance(r.report_status, str) else ""
    if rep in ("Questionable", "Doubtful"):
        f.append(f"{rep} on injury report" + (f" ({r.injury})" if isinstance(r.injury, str) and r.injury else ""))
    if rep == "Out":
        f.append("Out on injury report")
    if not r.injury_report_published and not r.game_completed:
        f.append("Injury report not yet published for this game")
    if r.changed_team == 1:
        f.append("New team since last game")
    if (r.missed_team_games or 0) >= 2:
        f.append(f"Missed {int(r.missed_team_games)} team games this season")
    if (r.n_games_cur or 0) < 2:
        f.append("Small current-season sample")
    return f


def _reasons(r) -> list[dict]:
    """Evidence tied to actual feature values. sign: +1 supports, -1 weakens, 0 context."""
    out = []
    if not r.has_history:
        return out
    if r.position in ("RB", "QB"):
        out.append({"sign": 1 if r.rz_carries_pg >= 2 else 0,
                    "text": f"{r.rz_carries_pg:.1f} carries inside the 20 per game ({r.goal5_carries_pg:.1f} inside the 5)"})
    if r.position in ("WR", "TE", "RB"):
        out.append({"sign": 1 if r.rz_targets_pg >= 1 else 0,
                    "text": f"{r.rz_targets_pg:.1f} red-zone targets per game; {r.ez_proxy_pg:.2f} end-zone target proxy per game"})
    if r.xtd_share == r.xtd_share and r.xtd_share is not None:
        out.append({"sign": 1 if r.xtd_share >= 0.25 else 0, "text": f"{r.xtd_share:.0%} of team play-based xTD in games played"})
    if r.team_implied_total == r.team_implied_total and r.team_implied_total is not None:
        out.append({"sign": 1 if r.team_implied_total >= 25 else (-1 if r.team_implied_total < 20 else 0),
                    "text": f"Team implied total {r.team_implied_total:.1f} pts (market spread/total)"})
    if r.opp_def_games == r.opp_def_games and r.opp_def_games:
        raw = r.opp_def_pos_td_pg_raw if r.opp_def_pos_td_pg_raw == r.opp_def_pos_td_pg_raw else 0
        sign = 1 if r.opp_def_pos_mult >= 1.15 else (-1 if r.opp_def_pos_mult <= 0.85 else 0)
        out.append({"sign": sign, "text": f"{r.opponent} allowed {raw:.2f} {r.position} TDs/game over {int(r.opp_def_games)} prior games "
                                          f"(league {r.league_pos_td_pg:.2f})"})
    if r.n_games_cur:
        out.append({"sign": 0, "text": f"Season: {int(r.cur_tds)} rush/rec TDs on {r.cur_xtd:.1f} play-based xTD in {int(r.n_games_cur)} games"})
    return out


def top3(c: sqlite3.Connection, run_id: str, exclude: set[str] | None = None) -> dict:
    """Up to three legs that pass the evidence rules; fewer when evidence is insufficient."""
    meta = c.execute("SELECT * FROM model_runs WHERE run_id=?", (run_id,)).fetchone()
    calibrated = bool(meta["calibrated"])
    df = pd.read_sql_query("SELECT * FROM predictions WHERE run_id=? AND eligible=1", c, params=(run_id,))
    if df.empty:
        return {"legs": [], "considered": 0, "rules": rules(calibrated), "calibrated": calibrated}
    feats = pd.json_normalize(df.features.map(json.loads))
    df = pd.concat([df.drop(columns=["features"]), feats.drop(columns=["status"], errors="ignore")], axis=1)
    df["status"] = "ACT"
    df["has_history"] = 1
    df["week"] = df["week"].astype(int)
    for col in ("n_games_cur", "missed_team_games", "changed_team"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    mask = backtest.top3_policy_mask(df)
    if exclude:
        mask &= ~df.player_id.isin(exclude)
    pool = df[mask]
    floor = (pool.p_model >= TOP3_MIN_P) if calibrated else (pool.score >= TOP3_MIN_PCTL)
    pool = pool[floor]
    col = "p_model" if calibrated else "score"
    sel = backtest.select_top(pool, col, 3, one_per_game=True)
    legs = []
    for _, r in sel.iterrows():
        legs.append({"player_id": r.player_id, "player_name": r.player_name, "team": r.team, "opponent": r.opponent,
                     "position": r.position, "game_id": r.game_id, "rank": int(r["rank"]), "score": float(r.score),
                     "p_model": float(r.p_model) if calibrated else None, "confidence": r.confidence,
                     "flags": json.loads(r["flags"]), "reasons": r["reasons"]})
    return {"legs": legs, "considered": int(len(df)), "passed_rules": int(mask.sum()), "passed_floor": int(len(pool)),
            "rules": rules(calibrated), "calibrated": calibrated}


def rules(calibrated: bool) -> list[str]:
    return [
        "Roster status ACT for the week; not listed Out, Doubtful or Questionable on the official injury report",
        "Played in the team's recent games (at most one missed team game this season; at least 3 games once Week 4+)",
        "Same team as his most recent game",
        "At most one leg per game (same-game outcomes are correlated)",
        (f"Validated probability of at least {TOP3_MIN_P:.0%}" if calibrated else
         f"Research score in the top {100 - TOP3_MIN_PCTL:.0f}% of eligible players"),
        "Fewer than three legs are returned when fewer candidates meet every rule",
    ]
