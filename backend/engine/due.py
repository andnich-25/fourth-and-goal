"""Is a player "due" for a touchdown? A walk-forward check of TD luck.

  python -m engine.due      # writes data/results/due.json

A player is flagged Due when, this season, his opportunities (carries and targets by field position, turned into
expected touchdowns, xTD) say he should have scored at least DUE_GAP more touchdowns than he has, over at least
DUE_MIN_GAMES games. The check asks two questions of every walk-forward test week:
  1. Do players with a given gap score at the rate the TD model gave them? (If due players beat their chance,
     the model is missing something.)
  2. Does adding the gap to the model's chance (a logistic fit on earlier weeks only) lower log loss on the next week?
The gap is factored into the chances only if (2) shows a gain. The result is cached per walk-forward run.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import db, paths, pipeline
from .util import utcnow

DUE_GAP = 1.5
DUE_MIN_GAMES = 3
BINS = [(-99, -1.5, "Scored 1.5+ more than expected"), (-1.5, -0.5, "Scored 0.5-1.5 more"), (-0.5, 0.5, "About as expected"),
        (0.5, 1.5 - 1e-9, "0.5-1.5 fewer than expected"), (1.5, 99, "Due: 1.5+ fewer than expected")]


def _ll(y, p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def _logit(p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def frame(c, run_id: str, model: str) -> pd.DataFrame:
    P = pd.read_sql_query("SELECT season, week, player_id, team, p, outcome FROM backtest_preds "
                          "WHERE run_id=? AND model=? AND outcome IS NOT NULL AND p IS NOT NULL", c, params=(run_id, model))
    f = pipeline.load_features()[["season", "week", "player_id", "team", "cur_xtd", "cur_tds", "n_games_cur", "cur_td_rate"]]
    m = P.merge(f, on=["season", "week", "player_id", "team"], how="left")
    m["gap"] = np.where(m.n_games_cur >= DUE_MIN_GAMES, m.cur_xtd - m.cur_tds, 0.0)
    return m.sort_values(["season", "week"]).reset_index(drop=True)


def adjustment_test(m: pd.DataFrame, warmup: int = 16) -> dict:
    from sklearn.linear_model import LogisticRegression  # noqa: PLC0415
    weeks = m[["season", "week"]].drop_duplicates().values.tolist()
    base = adj = 0.0
    n = 0
    by_season: dict = {}
    coef = None
    for i, (s, w) in enumerate(weeks):
        if i < warmup:
            continue
        tr = m[(m.season < s) | ((m.season == s) & (m.week < w))]
        te = m[(m.season == s) & (m.week == w)]
        fit = LogisticRegression(C=1.0).fit(np.c_[_logit(tr.p), tr.gap.clip(-4, 4)], tr.outcome)
        q = fit.predict_proba(np.c_[_logit(te.p), te.gap.clip(-4, 4)])[:, 1]
        b, a = _ll(te.outcome.values, te.p.values).sum(), _ll(te.outcome.values, q).sum()
        base, adj, n = base + b, adj + a, n + len(te)
        bs = by_season.setdefault(int(s), [0.0, 0.0, 0])
        bs[0] += b; bs[1] += a; bs[2] += len(te)
        coef = float(fit.coef_[0][1])
    return {"weeks": len(weeks) - warmup, "log_loss_model": base / n, "log_loss_with_gap": adj / n, "gain": (base - adj) / n,
            "gain_by_season": {k: (v[0] - v[1]) / v[2] for k, v in by_season.items()}, "last_gap_coef": coef}


def run(c, log=print) -> dict:
    wf = c.execute("SELECT run_id, model_version FROM model_runs WHERE kind='walk_forward' ORDER BY created_at DESC LIMIT 1").fetchone()
    if not wf or not wf[1] or wf[1] == "none":
        return {"available": False}
    run_id, model = wf
    m = frame(c, run_id, model)
    played = m[m.n_games_cur >= DUE_MIN_GAMES]
    bins = []
    for lo, hi, label in BINS:
        g = played[(played.gap > lo) & (played.gap <= hi)] if hi < 99 else played[played.gap >= lo]
        bins.append({"label": label, "lo": lo, "hi": hi, "n": int(len(g)), "avg_chance": float(g.p.mean()) if len(g) else None,
                     "hit_rate": float(g.outcome.mean()) if len(g) else None,
                     "season_td_rate": float(g.cur_td_rate.mean()) if len(g) else None})
    test = adjustment_test(m)
    log(f"due: gain {test['gain']:.6f} over {test['weeks']} weeks")
    out = {"available": True, "created_at": utcnow(), "run_id": run_id, "model": model, "due_gap": DUE_GAP, "min_games": DUE_MIN_GAMES,
           "bins": bins, "test": test, "factored_in": bool(test["gain"] > 0)}
    paths.results_dir().mkdir(parents=True, exist_ok=True)
    (paths.results_dir() / "due.json").write_text(json.dumps(out, indent=2, default=float))
    return out


def latest(c) -> dict:
    """The cached study for the current walk-forward run, rerun when the run changes."""
    f = paths.results_dir() / "due.json"
    wf = c.execute("SELECT run_id FROM model_runs WHERE kind='walk_forward' ORDER BY created_at DESC LIMIT 1").fetchone()
    if f.exists():
        r = json.loads(f.read_text())
        if wf and r.get("run_id") == wf[0]:
            return r
    try:
        return run(c, log=lambda *_: None)
    except FileNotFoundError:
        return {"available": False}


if __name__ == "__main__":
    con = db.connect(paths.db_path())
    print(json.dumps(run(con), indent=2, default=float))
