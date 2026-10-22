"""How much more should recent seasons count? A walk-forward study of recency weighting.

  python -m engine.recency      # writes data/results/recency.json

Each candidate half-life (in seasons) weights a training game by 0.5 ** (age / half_life). The touchdown model
(promoted type) and every promoted prop market are refit week by week with each weighting. The half-life is
chosen on the early test seasons only, then checked once on the later seasons; it is adopted only if it is not
worse than equal weights there. The chosen values are written into models.RECENCY_HALF_LIFE and
props.RECENCY_HALF_LIFE by hand, so a change is always visible in the code.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import db, models, paths, pipeline, props
from .util import utcnow

HALF_LIVES = [None, 3.0, 2.0, 1.0]
LABEL = {None: "Equal weight", 3.0: "Halves every 3 seasons", 2.0: "Halves every 2 seasons", 1.0: "Halves every season"}


def _ll(y, p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def td_study(c, feats: pd.DataFrame, weeks, log=print) -> pd.DataFrame:
    team_games = pd.read_sql_query("SELECT season, week, offensive_tds, implied_total FROM team_game", c)
    f = feats[feats.position.isin(models.POS_PRIOR_SHARE)]
    lab = f[(f.participated == 1) & (f.has_history == 1) & f.scored_anytime.notna()].copy()
    lab["scored_anytime"] = lab.scored_anytime.astype(int)
    rows = []
    for s, w in weeks:
        train = lab[(lab.season < s) | ((lab.season == s) & (lab.week < w))]
        test = lab[(lab.season == s) & (lab.week == w)]
        if len(train) < 1500 or test.empty:
            continue
        tg = team_games[(team_games.season < s) | ((team_games.season == s) & (team_games.week < w))]
        y = test.scored_anytime.to_numpy()
        for h in HALF_LIVES:
            for recal in (False, True):
                p = models.LogitModel(half_life=h or 0, recalibrate=recal).fit(train, tg).predict(test)
                top = p >= 0.5
                rows.append({"season": s, "week": w, "half_life": h, "recal": recal, "n": len(y), "loss": float(_ll(y, p).sum()),
                             "top_n": int(top.sum()), "top_pred": float(p[top].sum()), "top_obs": float(y[top].sum())})
        log(f"recency TD {s} W{w}")
    return pd.DataFrame(rows)


def prop_study(c, weeks, log=print) -> pd.DataFrame:
    feats = pipeline.load_features()
    frame = props.build_frame(c, None)
    lab = frame[frame.labelled == 1]
    rep = props.latest_report(c) or {"markets": {}}
    rows = []
    for market, r in rep["markets"].items():
        name = r["gate"]["promoted"]
        if not name:
            continue
        st = props.MARKETS[market]["stat"]
        pop = lab[props.population(lab, market)]
        for s, w in weeks:
            train = pop[(pop.season < s) | ((pop.season == s) & (pop.week < w))]
            test = pop[(pop.season == s) & (pop.week == w)]
            if len(train) < 400 or test.empty:
                continue
            for h in HALF_LIVES:
                old = props.RECENCY_HALF_LIFE
                props.RECENCY_HALF_LIFE = h or 0
                try:
                    m, dist = props.fit_market_model(name, market, train)
                finally:
                    props.RECENCY_HALF_LIFE = old
                crps = props.crps_from_quantiles(dist.quantiles(m.predict(test)), test[st].to_numpy(float))
                rows.append({"market": market, "season": s, "week": w, "half_life": h, "n": len(test), "loss": float(crps.sum())})
        log(f"recency props {market} done")
    del feats
    return pd.DataFrame(rows)


def _hkey(h) -> str:
    return "none" if h is None or (isinstance(h, float) and np.isnan(h)) else str(h)


def _choose(df: pd.DataFrame, split: int) -> dict:
    keys = df.half_life.map(_hkey)
    if "recal" in df:
        keys = keys + np.where(df.recal, "+recal", "")
    df = df.assign(key=keys)
    sel, hold = df[df.season <= split], df[df.season > split]
    agg = lambda d: (d.groupby("key").loss.sum() / d.groupby("key").n.sum()).to_dict()  # noqa: E731
    a, b = agg(sel), agg(hold)
    best = min(a, key=a.get)
    adopt = best != "none" and b.get(best, np.inf) <= b.get("none", np.inf)
    out = {"selection": a, "holdout": b, "best_on_selection": best, "adopted": best if adopt else "none",
           "holdout_gain_vs_equal": (b["none"] - b[best]) if best in b and "none" in b else None}
    if "top_n" in df:
        t = df.groupby("key")[["top_n", "top_pred", "top_obs"]].sum()
        out["top_end"] = {k: {"n": int(r.top_n), "predicted": r.top_pred / r.top_n if r.top_n else None,
                              "observed": r.top_obs / r.top_n if r.top_n else None} for k, r in t.iterrows()}
    return out


def run(log=print) -> dict:
    c = db.connect(paths.db_path())
    try:
        season = int(c.execute("SELECT MAX(season) FROM games").fetchone()[0])
        weeks = pipeline.test_weeks(c, season)
        split = season - 3  # 2021-2023 choose, 2024-2026 check
        td = td_study(c, pipeline.load_features(), weeks, log)
        pr = prop_study(c, weeks, log)
        out = {"created_at": utcnow(), "half_lives": [LABEL[h] for h in HALF_LIVES], "split_after_season": split,
               "td": _choose(td, split), "props": {m: _choose(g, split) for m, g in pr.groupby("market")} if len(pr) else {},
               "labels": {("none" if h is None else str(h)): LABEL[h] for h in HALF_LIVES}}
        (paths.results_dir() / "recency.json").write_text(json.dumps(out, indent=2, default=float))
        log(json.dumps(out, indent=2, default=float))
        return out
    finally:
        c.close()


if __name__ == "__main__":
    run()
