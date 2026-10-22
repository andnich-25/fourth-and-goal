"""Chronological walk-forward validation, metrics, selection policy and the promotion gate."""
from __future__ import annotations

import json
import math
import sqlite3
import uuid

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

from . import models
from .util import utcnow

EXCLUDE_STATUS_RANK = ("Out", "Doubtful")
EXCLUDE_STATUS_TOP3 = ("Out", "Doubtful", "Questionable")
GATE = {
    "min_test_rows": 2000,
    "min_test_weeks": 10,
    "max_ece": 0.025,
    "must_beat": ["baseline-position-rate", "baseline-shrunk-player-rate"],
    "bootstrap_reps": 300,
    "parsimony_tolerance": 0.001,
}


# --------------------------------------------------------------------------- metrics
def wilson(hits: int, n: int, z: float = 1.959963984540054):
    if n == 0:
        return (None, None)
    p = hits / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, c - m), min(1.0, c + m))


def calibration_bins(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if m.sum() == 0:
            continue
        out.append({"lo": round(float(lo), 2), "hi": round(float(hi), 2), "n": int(m.sum()),
                    "mean_pred": float(p[m].mean()), "observed": float(y[m].mean()),
                    "ci": wilson(int(y[m].sum()), int(m.sum()))})
    return out


def prob_metrics(y, p) -> dict:
    y = np.asarray(y, dtype=int)
    p = np.clip(np.asarray(p, dtype=float), models.EPS, 1 - models.EPS)
    bins = calibration_bins(y, p)
    ece = sum(b["n"] * abs(b["mean_pred"] - b["observed"]) for b in bins) / len(y) if len(y) else None
    return {"n": int(len(y)), "base_rate": float(y.mean()) if len(y) else None,
            "brier": float(np.mean((p - y) ** 2)) if len(y) else None,
            "log_loss": models._logloss(y, p) if len(y) else None,
            "auc": float(roc_auc_score(y, p)) if len(set(y)) == 2 else None,
            "ece": ece, "calibration": bins}


def select_top(pool: pd.DataFrame, score_col: str, n: int, one_per_game: bool) -> pd.DataFrame:
    pool = pool.sort_values(score_col, ascending=False)
    if not one_per_game:
        return pool.head(n)
    picked, games = [], set()
    for idx, r in pool.iterrows():
        if r.game_id in games:
            continue
        picked.append(idx)
        games.add(r.game_id)
        if len(picked) == n:
            break
    return pool.loc[picked]


def top3_policy_mask(df: pd.DataFrame) -> pd.Series:
    """Evidence rules for the Top 3 shortlist (shared by live slate and backtest)."""
    status_ok = df.status.eq("ACT") if "status" in df else True
    rep = df.report_status.fillna("") if "report_status" in df else pd.Series("", index=df.index)
    recent = df.n_games_cur.fillna(0) >= np.minimum(3, np.maximum(df.week - 1, 0))
    played_recent = df.missed_team_games.fillna(0) <= 1
    return (status_ok & ~rep.isin(EXCLUDE_STATUS_TOP3) & recent & played_recent & df.changed_team.fillna(0).eq(0)
            & df.has_history.eq(1))


# --------------------------------------------------------------------------- walk-forward
def walk_forward(c: sqlite3.Connection, feats: pd.DataFrame, test_weeks: list[tuple[int, int]], log=print) -> dict:
    run_id = "wf-" + uuid.uuid4().hex[:10]
    team_games = pd.read_sql_query("SELECT season, week, offensive_tds, implied_total FROM team_game", c)
    f = feats[feats.position.isin(models.POS_PRIOR_SHARE)].copy()
    labeled = f[(f.participated == 1) & (f.has_history == 1) & f.scored_anytime.notna()].copy()
    labeled["scored_anytime"] = labeled.scored_anytime.astype(int)
    preds = []
    for s, w in test_weeks:
        before = (labeled.season < s) | ((labeled.season == s) & (labeled.week < w))
        train = labeled[before]
        week_rows = f[(f.season == s) & (f.week == w) & (f.has_history == 1)].copy()
        if len(train) < 1500 or week_rows.empty:
            log(f"skip {s} W{w}: train={len(train)} rows={len(week_rows)}")
            continue
        tg = team_games[(team_games.season < s) | ((team_games.season == s) & (team_games.week < w))]
        for name, cls in {**models.CANDIDATES, **models.BASELINES}.items():
            m = cls().fit(train, tg)
            week_rows[f"p::{name}"] = m.predict(week_rows)
        week_rows["p::baseline-opportunity"] = models.opportunity_score(week_rows)
        preds.append(week_rows)
        log(f"walk-forward {s} W{w}: train={len(train):,} predicted={len(week_rows):,}")
    if not preds:
        raise RuntimeError("No test weeks could be evaluated (insufficient earlier data).")
    P = pd.concat(preds)
    # Top-end correction from earlier test weeks only (models.TopEnd); the raw chance is kept as the stored score.
    t = (P.season * 100 + P.week).to_numpy()
    y = np.where((P.participated == 1) & P.scored_anytime.notna(), P.scored_anytime, np.nan).astype(float)
    for name in models.CANDIDATES:
        P[f"raw::{name}"] = P[f"p::{name}"]
        P[f"p::{name}"] = models.top_end_walk_forward(t, P[f"p::{name}"].to_numpy(float), y)
    report = evaluate(P, run_id)
    _store(c, run_id, P, report)
    return report


def evaluate(P: pd.DataFrame, run_id: str) -> dict:
    names = list(models.CANDIDATES) + list(models.BASELINES)
    ev = P[(P.participated == 1) & P.scored_anytime.notna()]
    y = ev.scored_anytime.astype(int).values
    overall = {n: prob_metrics(y, ev[f"p::{n}"].values) for n in names}
    by_pos = {n: {pos: prob_metrics(g.scored_anytime.astype(int).values, g[f"p::{n}"].values) | {"calibration": None}
                  for pos, g in ev.groupby("position")} for n in names}
    by_season = {n: {int(s): {k: v for k, v in prob_metrics(g.scored_anytime.astype(int).values, g[f"p::{n}"].values).items() if k != "calibration"}
                     for s, g in ev.groupby("season")} for n in names}

    # Top-N hit rates among the pregame pool (roster ACT, not Out/Doubtful). Picks that did not play are void.
    rank_names = names + ["baseline-opportunity"]
    pool = P[P.status.eq("ACT") & ~P.report_status.fillna("").isin(EXCLUDE_STATUS_RANK)]
    weeks = sorted(set(zip(P.season, P.week)))
    topn = {n: {} for n in rank_names}
    weekly = []
    picks_out = []
    for n in rank_names:
        col = f"p::{n}"
        for k in (1, 3, 5, 10):
            hits = voids = picks = 0
            for s, w in weeks:
                wp = pool[(pool.season == s) & (pool.week == w)]
                sel = select_top(wp, col, k, one_per_game=False)
                picks += len(sel)
                voids += int((sel.participated != 1).sum())
                hits += int(((sel.participated == 1) & (sel.scored_anytime == 1)).sum())
            graded = picks - voids
            topn[n][f"top{k}"] = {"hits": hits, "graded": graded, "voids": voids,
                                  "hit_rate": hits / graded if graded else None, "ci": wilson(hits, graded)}
        # Top 3 policy (evidence rules + one leg per game), all-3 rate.
        all3 = issued3 = legs = leg_hits = leg_void = 0
        for s, w in weeks:
            wp = pool[(pool.season == s) & (pool.week == w)]
            wp = wp[top3_policy_mask(wp)]
            sel = select_top(wp, col, 3, one_per_game=True)
            graded = sel[sel.participated == 1]
            legs += len(graded)
            leg_void += len(sel) - len(graded)
            h = int((graded.scored_anytime == 1).sum())
            leg_hits += h
            if len(sel) == 3 and len(graded) == 3:
                issued3 += 1
                all3 += int(h == 3)
            if n in ("fg-structural-1", "fg-logit-1", "fg-gbm-1", "baseline-shrunk-player-rate", "baseline-opportunity"):
                for _, r in sel.iterrows():
                    picks_out.append({"model": n, "season": int(s), "week": int(w), "player_id": r.player_id,
                                      "player_name": r.player_name, "team": r.team, "position": r.position,
                                      "opponent": r.opponent, "score": float(r[col]),
                                      "participated": int(r.participated == 1),
                                      "scored": None if r.participated != 1 else int(r.scored_anytime == 1)})
        topn[n]["top3_policy"] = {"legs_graded": legs, "leg_hits": leg_hits, "voids": leg_void,
                                  "leg_hit_rate": leg_hits / legs if legs else None, "ci": wilson(leg_hits, legs),
                                  "weeks_with_3_legs": issued3, "all3_hits": all3,
                                  "all3_rate": all3 / issued3 if issued3 else None, "weeks": len(weeks),
                                  "coverage": issued3 / len(weeks) if weeks else None}

    for s, w in weeks:
        g = ev[(ev.season == s) & (ev.week == w)]
        row = {"season": int(s), "week": int(w), "n": int(len(g)), "scorers": int(g.scored_anytime.sum())}
        for n in names:
            pm = prob_metrics(g.scored_anytime.astype(int).values, g[f"p::{n}"].values)
            row[n] = {"brier": pm["brier"], "log_loss": pm["log_loss"]}
        for n in rank_names:
            wp = pool[(pool.season == s) & (pool.week == w)]
            sel = select_top(wp, f"p::{n}", 3, one_per_game=False)
            gr = sel[sel.participated == 1]
            row[f"{n}::top3_hits"] = int((gr.scored_anytime == 1).sum())
            row[f"{n}::top3_graded"] = int(len(gr))
        weekly.append(row)

    gate = promotion_gate(ev, overall, by_season, weeks)
    return {"run_id": run_id, "created_at": utcnow(), "test_weeks": [list(map(int, x)) for x in weeks],
            "eligible_population": "QB/RB/WR/TE player-games with at least one earlier participated game; "
                                   "players without a box-score row or offensive snaps are excluded as did-not-play (void).",
            "overall": overall, "by_position": by_pos, "by_season": by_season, "topn": topn, "weekly": weekly,
            "picks": picks_out, "gate": gate}


def promotion_gate(ev, overall, by_season, weeks) -> dict:
    rng = np.random.default_rng(11)
    wk = ev.assign(_wk=list(zip(ev.season, ev.week)))
    groups = {k: g for k, g in wk.groupby("_wk")}
    keys = list(groups)
    results = {}
    for cand in models.CANDIDATES:
        checks = []
        m = overall[cand]
        checks.append({"check": f"Test rows >= {GATE['min_test_rows']}", "value": m["n"], "pass": m["n"] >= GATE["min_test_rows"]})
        checks.append({"check": f"Test weeks >= {GATE['min_test_weeks']}", "value": len(weeks), "pass": len(weeks) >= GATE["min_test_weeks"]})
        for b in GATE["must_beat"]:
            checks.append({"check": f"Log loss below {b}", "value": [m["log_loss"], overall[b]["log_loss"]],
                           "pass": m["log_loss"] < overall[b]["log_loss"]})
            checks.append({"check": f"Brier below {b}", "value": [m["brier"], overall[b]["brier"]],
                           "pass": m["brier"] < overall[b]["brier"]})
        # Block bootstrap over weeks: improvement in log loss vs the strongest baseline must exclude zero.
        strongest = min(GATE["must_beat"], key=lambda b: overall[b]["log_loss"])
        diffs = []
        for _ in range(GATE["bootstrap_reps"]):
            sample = pd.concat([groups[keys[i]] for i in rng.integers(0, len(keys), len(keys))])
            yy = sample.scored_anytime.astype(int).values
            diffs.append(models._logloss(yy, sample[f"p::{strongest}"].values) - models._logloss(yy, sample[f"p::{cand}"].values))
        lo, hi = float(np.percentile(diffs, 2.5)), float(np.percentile(diffs, 97.5))
        checks.append({"check": f"95% week-bootstrap CI of log-loss gain vs {strongest} excludes 0", "value": [lo, hi], "pass": lo > 0})
        checks.append({"check": f"ECE <= {GATE['max_ece']}", "value": m["ece"], "pass": m["ece"] is not None and m["ece"] <= GATE["max_ece"]})
        latest = max(by_season[cand])
        checks.append({"check": f"Not worse than {strongest} on latest season ({latest}) log loss",
                       "value": [by_season[cand][latest]["log_loss"], by_season[strongest][latest]["log_loss"]],
                       "pass": by_season[cand][latest]["log_loss"] <= by_season[strongest][latest]["log_loss"]})
        results[cand] = {"passed": all(x["pass"] for x in checks), "checks": checks, "log_loss": m["log_loss"]}
    passing = [k for k, v in results.items() if v["passed"]]
    promoted = None
    if passing:
        # Parsimony: take the simplest passing model within tolerance of the best log loss.
        best = min(results[k]["log_loss"] for k in passing)
        order = list(models.CANDIDATES)  # listed simplest first
        promoted = next(k for k in order if k in passing and results[k]["log_loss"] <= best + GATE["parsimony_tolerance"])
    return {"criteria": GATE, "candidates": results, "promoted": promoted}


def _store(c, run_id, P, report):
    gate = report["gate"]
    with c:
        c.execute("INSERT INTO model_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (run_id, "walk_forward", gate["promoted"] or "none", report["created_at"],
                   max(s for s, _ in report["test_weeks"]), None, None, None,
                   json.dumps({"candidates": list(models.CANDIDATES), "baselines": list(models.BASELINES)}),
                   json.dumps(report, default=float), json.dumps(gate, default=float),
                   int(gate["promoted"] is not None), int(gate["promoted"] is not None)))
        names = list(models.CANDIDATES) + list(models.BASELINES) + ["baseline-opportunity"]
        base = P[["season", "week", "player_id", "team", "position", "player_name", "scored_anytime", "status"]]
        rows = []
        for n in names:
            vals = P[f"p::{n}"].values
            raw = P[f"raw::{n}"].values if f"raw::{n}" in P else vals
            for (s, w, pid, team, pos, name, y, st), v, r in zip(base.itertuples(index=False, name=None), vals, raw):
                prob = None if n == "baseline-opportunity" else float(v)
                rows.append((run_id, n, int(s), int(w), pid, team, pos, name, prob, float(r),
                             None if y != y else int(y), int(st == "ACT")))
        c.executemany("INSERT OR REPLACE INTO backtest_preds VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
