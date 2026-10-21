"""Touchdown model tuning study.

  python -m engine.tuning            # writes results/tuning.json (about 30-40 minutes)

Protocol (guards against tuning to noise):
  1. Selection set = 2025 Weeks 1-18. Every setting is scored by walk-forward log loss there
     (each week predicted by a model fit only on earlier games).
  2. Stage A tunes the feature builder (recency window, last-season weight, defense shrinkage).
  3. Stage B adds candidate metrics one at a time (greedy forward selection) and tunes regularisation.
  4. Holdout = 2026 Weeks 1-6, never used for any choice above. The tuned model replaces the
     current one only if it is at least as good there too.
"""
from __future__ import annotations

import itertools
import json
import time

import numpy as np
import pandas as pd

from . import backtest, db, features, models, paths, status
from .util import utcnow

SELECTION = [(2025, w) for w in range(1, 19)]
GRID_A = {"window": [4, 6, 8, 12], "prior_season_weight": [0.25, 0.5, 0.75], "def_shrink_games": [2.0, 4.0, 8.0]}
CANDIDATE_FEATURES = ["opp_implied_total", "spread_for", "cur_td_rate", "cur_xtd_pg", "team_rz_trips_pg", "opp_def_rz_td_rate",
                      "opp_def_rz_trips_pg", "opp_def_pos_l4_mult", "rz_x_def", "is_home"]
C_GRID = [0.05, 0.1, 0.25, 0.5, 1.0, 2.0]
MIN_GAIN = 0.0003  # log-loss improvement needed to keep an added metric


def build(c, season, window, prior_weight, def_shrink) -> pd.DataFrame:
    old = features.WINDOW, features.PRIOR_SEASON_WEIGHT, features.DEF_SHRINK_GAMES
    features.WINDOW, features.PRIOR_SEASON_WEIGHT, features.DEF_SHRINK_GAMES = window, prior_weight, def_shrink
    try:
        wk = status.current_week(c, season)
        t = features.build_targets(c, [season - 2, season - 1, season], extra_weeks=[(season, wk)] if wk else None)
        return features.compute_features(c, t)
    finally:
        features.WINDOW, features.PRIOR_SEASON_WEIGHT, features.DEF_SHRINK_GAMES = old


def predict(c, feats: pd.DataFrame, factory, weeks) -> pd.DataFrame:
    team_games = pd.read_sql_query("SELECT season, week, offensive_tds, implied_total FROM team_game", c)
    f = feats[feats.position.isin(models.POS_PRIOR_SHARE)]
    lab = f[(f.participated == 1) & (f.has_history == 1) & f.scored_anytime.notna()].copy()
    lab["scored_anytime"] = lab.scored_anytime.astype(int)
    out = []
    for s, w in weeks:
        train = lab[(lab.season < s) | ((lab.season == s) & (lab.week < w))]
        rows = f[(f.season == s) & (f.week == w) & (f.has_history == 1)].copy()
        if len(train) < 1500 or rows.empty:
            continue
        tg = team_games[(team_games.season < s) | ((team_games.season == s) & (team_games.week < w))]
        rows["p"] = factory().fit(train, tg).predict(rows)
        out.append(rows)
    return pd.concat(out)


def score(P: pd.DataFrame) -> dict:
    ev = P[(P.participated == 1) & P.scored_anytime.notna()]
    y = ev.scored_anytime.astype(int).values
    pm = backtest.prob_metrics(y, ev.p.values)
    pool = P[P.status.eq("ACT") & ~P.report_status.fillna("").isin(backtest.EXCLUDE_STATUS_RANK)]
    legs = hits = all3 = full = top5_hits = top5_graded = 0
    for (s, w), wp in pool.groupby(["season", "week"]):
        sel = backtest.select_top(wp[backtest.top3_policy_mask(wp)], "p", 3, one_per_game=True)
        g = sel[sel.participated == 1]
        legs += len(g)
        h = int((g.scored_anytime == 1).sum())
        hits += h
        if len(sel) == 3 and len(g) == 3:
            full += 1
            all3 += int(h == 3)
        t5 = backtest.select_top(wp, "p", 5, one_per_game=False)
        t5 = t5[t5.participated == 1]
        top5_graded += len(t5)
        top5_hits += int((t5.scored_anytime == 1).sum())
    return {"n": pm["n"], "log_loss": pm["log_loss"], "brier": pm["brier"], "auc": pm["auc"], "ece": pm["ece"],
            "top3_policy_legs": legs, "top3_policy_hits": hits, "top3_policy_rate": hits / legs if legs else None,
            "all3_weeks": all3, "weeks_with_3": full, "top5_hits": top5_hits, "top5_graded": top5_graded,
            "top5_rate": top5_hits / top5_graded if top5_graded else None}


def logit(features_=None, C=None):
    return lambda: models.LogitModel(features=features_, C=C)


def bootstrap_ll_gain(A: pd.DataFrame, B: pd.DataFrame, reps=500) -> tuple[float, float]:
    """95% week-bootstrap CI of log loss(A) - log loss(B) on the same rows (positive = B better)."""
    key = ["season", "week", "player_id", "team"]
    m = A[key + ["p", "participated", "scored_anytime"]].merge(B[key + ["p"]], on=key, suffixes=("_a", "_b"))
    m = m[(m.participated == 1) & m.scored_anytime.notna()]
    y = m.scored_anytime.astype(int).values

    def ll(p):
        p = np.clip(p, 1e-4, 1 - 1e-4)
        return -(y * np.log(p) + (1 - y) * np.log(1 - p))

    m["d"] = ll(m.p_a.values) - ll(m.p_b.values)
    wk = m.groupby(["season", "week"]).d.agg(["sum", "count"])
    rng = np.random.default_rng(3)
    sims = []
    for _ in range(reps):
        i = rng.integers(0, len(wk), len(wk))
        sims.append(wk["sum"].values[i].sum() / wk["count"].values[i].sum())
    return float(np.quantile(sims, 0.025)), float(np.quantile(sims, 0.975))


def run(season=2026, log=print) -> dict:
    t0 = time.time()
    c = db.connect(paths.db_path())
    holdout = [(season, w) for w in range(1, (status.current_week(c, season) or 19))]
    res = {"created_at": utcnow(), "selection_weeks": SELECTION, "holdout_weeks": holdout, "stage_a": [], "stage_b": [], "c_grid": []}

    # Stage A: feature builder settings, scored with the current model specification.
    for win, pw, ds in itertools.product(*GRID_A.values()):
        feats = build(c, season, win, pw, ds)
        sc = score(predict(c, feats, logit(), SELECTION))
        res["stage_a"].append({"window": win, "prior_season_weight": pw, "def_shrink_games": ds, **sc})
        log(f"A win={win} prior={pw} def={ds}: ll={sc['log_loss']:.4f} top3={sc['top3_policy_hits']}/{sc['top3_policy_legs']} "
            f"({time.time() - t0:.0f}s)")
    best_a = min(res["stage_a"], key=lambda r: r["log_loss"])
    key_a = (best_a["window"], best_a["prior_season_weight"], best_a["def_shrink_games"])
    feats = build(c, season, *key_a)
    log(f"Stage A best: {key_a} ll={best_a['log_loss']:.4f}")

    # Stage B: greedy forward selection of candidate metrics, then regularisation.
    chosen = list(models.ML_FEATURES)
    current = score(predict(c, feats, logit(chosen), SELECTION))["log_loss"]
    remaining = list(CANDIDATE_FEATURES)
    while remaining:
        trials = []
        for f_ in remaining:
            sc = score(predict(c, feats, logit(chosen + [f_]), SELECTION))
            trials.append((sc["log_loss"], f_, sc))
            log(f"B try +{f_}: ll={sc['log_loss']:.4f} ({time.time() - t0:.0f}s)")
        ll, f_, sc = min(trials)
        res["stage_b"].append({"added": f_, "accepted": current - ll >= MIN_GAIN, "log_loss": ll, "previous": current, **sc,
                               "all_trials": {t[1]: t[0] for t in trials}})
        if current - ll < MIN_GAIN:
            break
        chosen.append(f_)
        remaining.remove(f_)
        current = ll
        log(f"B accept +{f_}: ll={ll:.4f}")
    for C in C_GRID:
        sc = score(predict(c, feats, logit(chosen, C), SELECTION))
        res["c_grid"].append({"C": C, **sc})
        log(f"C={C}: ll={sc['log_loss']:.4f}")
    best_c = min(res["c_grid"], key=lambda r: r["log_loss"])["C"]
    tuned = {"window": key_a[0], "prior_season_weight": key_a[1], "def_shrink_games": key_a[2], "features": chosen, "C": best_c}
    res["tuned"] = tuned

    # Holdout: 2026 weeks never used above. Current production spec vs tuned spec.
    base_feats = build(c, season, features.WINDOW, features.PRIOR_SEASON_WEIGHT, features.DEF_SHRINK_GAMES)
    cur_sel = score(predict(c, base_feats, logit(), SELECTION))
    P_cur = predict(c, base_feats, logit(), holdout)
    P_new = predict(c, feats, logit(chosen, best_c), holdout)
    P_new_sel = predict(c, feats, logit(chosen, best_c), SELECTION)
    lo, hi = bootstrap_ll_gain(P_cur, P_new)
    res["comparison"] = {
        "current": {"selection": cur_sel, "holdout": score(P_cur)},
        "tuned": {"selection": score(P_new_sel), "holdout": score(P_new)},
        "holdout_ll_gain_ci": [lo, hi],
    }
    res["adopt"] = res["comparison"]["tuned"]["holdout"]["log_loss"] <= res["comparison"]["current"]["holdout"]["log_loss"]
    res["seconds"] = round(time.time() - t0)
    out = paths.results_dir() / "tuning.json"
    out.write_text(json.dumps(res, indent=1, default=float))
    log(f"tuning done in {res['seconds']}s; adopt={res['adopt']}; written {out}")
    c.close()
    return res


if __name__ == "__main__":
    run()
