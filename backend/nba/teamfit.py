"""Team scoring check: each player is projected from his own history, so a team that adds stars (or loses them) gets
player projections that add up to more (or fewer) points than the team actually scores. When a team's projected
rotation points are high against its usual scoring, players come in under, and the other way round:

    actual points ≈ projected points × exp(a + b × log(team's projected rotation points / team's usual points))

The fit uses the walk-forward's out-of-sample predictions only. Who counts toward a team's sum is decided before the
game (players who played the team's previous game), so the test uses nothing that was unknown at tip-off. It is used
on the live slate only if it beats the plain model on the held-out seasons.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats as st

from . import props

MIN_MINUTES = 15          # rotation players: the same rule as the site's rows
HOLDOUT_SEASONS = 2       # fit on earlier seasons, judge on the last two full seasons


def _pregame_sums(w: pd.DataFrame) -> pd.DataFrame:
    """One row per played player-game with his team's projected rotation points (S) and usual points (pf)."""
    w = w[w.min_l >= MIN_MINUTES]
    order = w[["team", "game_id", "game_date"]].drop_duplicates().sort_values("game_date")
    order["prev_game"] = order.groupby("team").game_id.shift(1)
    w = w.merge(order[["team", "game_id", "prev_game"]], on=["team", "game_id"])
    played = set(zip(w.loc[w.played, "game_id"], w.loc[w.played, "player_id"]))
    w = w.assign(avail=[(g, p) in played for g, p in zip(w.prev_game, w.player_id)])
    sums = w[w.avail].groupby(["game_id", "team"]).agg(S=("mu", "sum"), pf=("pts_for", "first")).reset_index()
    out = w[w.played].merge(sums, on=["game_id", "team"])
    return out[(out.S > 0) & (out.pf > 0)].assign(load=lambda x: np.log(x.S / x.pf))


def fit_poisson(y: np.ndarray, mu: np.ndarray, load: np.ndarray) -> tuple[float, float]:
    """Maximum-likelihood a, b for y ~ Poisson(mu × exp(a + b × load)) by Newton steps."""
    ab = np.zeros(2)
    X = np.c_[np.ones(len(y)), load]
    for _ in range(50):
        m = mu * np.exp(X @ ab)
        step = np.linalg.solve(X.T @ (X * m[:, None]), X.T @ (y - m))
        ab += step
        if np.abs(step).max() < 1e-9:
            break
    return float(ab[0]), float(ab[1])


def factor(load, a: float, b: float):
    return np.exp(a + b * np.asarray(load, float))


def _score(x: pd.DataFrame, mu: np.ndarray) -> dict:
    n, p = props.nb_params(mu, x.alpha.to_numpy())
    po = props.apply_platt(1 - st.nbinom.cdf(np.floor(x.line.to_numpy()), n, p), [1.0, 0.0])
    hit = np.where(po >= 0.5, x.y > x.line, x.y < x.line)
    strong = np.maximum(po, 1 - po) >= 0.6
    return {"lean_hit": float(hit.mean()), "strong_hit": float(hit[strong].mean()), "strong_n": int(strong.sum()),
            "avg_miss": float(np.mean(np.abs(x.y - mu)))}


def fit(oos_points: pd.DataFrame) -> dict:
    w = _pregame_sums(oos_points)
    w = w[w.line.notna() & (w.line >= 1.5)]
    seasons = sorted(s for s, k in w.groupby("season").size().items() if k >= 5000)
    if len(seasons) <= HOLDOUT_SEASONS:
        return {"use": False, "reason": "not enough seasons"}
    test_from = seasons[-HOLDOUT_SEASONS]
    tr, te = w[w.season < test_from], w[w.season >= test_from]
    a, b = fit_poisson(tr.y.to_numpy(), tr.mu.to_numpy(), tr.load.to_numpy())
    plain = _score(te, te.mu.to_numpy())
    adjusted = _score(te, te.mu.to_numpy() * factor(te.load, a, b))
    use = (adjusted["lean_hit"] > plain["lean_hit"] and adjusted["strong_hit"] >= plain["strong_hit"]
           and adjusted["avg_miss"] <= plain["avg_miss"])
    # live projections use the fit on every season
    a_all, b_all = fit_poisson(w.y.to_numpy(), w.mu.to_numpy(), w.load.to_numpy())
    return {"use": bool(use), "a": a_all, "b": b_all, "test_seasons": [int(s) for s in seasons[-HOLDOUT_SEASONS:]],
            "test_rows": int(len(te)), "fit_on_earlier": {"a": a, "b": b}, "plain": plain, "adjusted": adjusted}


def apply(res: pd.DataFrame, fit_: dict, log=print) -> pd.DataFrame:
    """Scale each team's points (and the points inside PRA) on the live slate; distributions keep their spread."""
    if not fit_.get("use") or res.empty:
        return res
    res = res.copy()
    pts = res[res.market == "points"]
    rot = pts[(pts.min_l >= MIN_MINUTES) & ~pts.out]
    sums = rot.groupby(["game_id", "team"]).agg(S=("mu", "sum"), pf=("pts_for", "first"))
    sums["f"] = factor(np.log(sums.S / sums.pf), fit_["a"], fit_["b"])
    f = res.set_index(["game_id", "team"]).index.map(sums.f.to_dict()).to_numpy(dtype=float)
    f = np.where(np.isnan(f), 1.0, f)
    pmu = res.player_id.map(pts.set_index("player_id").mu).to_numpy(dtype=float)
    new = res.mu.to_numpy(dtype=float).copy()
    is_pts, is_pra = (res.market == "points").to_numpy(), (res.market == "pra").to_numpy()
    new[is_pts] = new[is_pts] * f[is_pts]
    new[is_pra] = new[is_pra] + (f[is_pra] - 1) * np.nan_to_num(pmu[is_pra])
    changed = is_pts | is_pra
    for i in np.flatnonzero(changed):
        d = res.dist.iat[i]
        n = d["n"]
        p = n / (n + new[i])
        res.at[res.index[i], "dist"] = {**d, "p": float(p),
                                         "cdf": [round(float(x), 5) for x in st.nbinom.cdf(np.arange(int(new[i] * 3 + 25)), n, p)]}
        res.at[res.index[i], "q10"] = st.nbinom.ppf(0.1, n, p)
        res.at[res.index[i], "q90"] = st.nbinom.ppf(0.9, n, p)
    res["team_factor"] = np.where(changed, f, 1.0)
    res["mu"] = new
    for (g, t), r in sums.iterrows():
        log(f"nba team check {t}: rotation {r.S:.0f} pts vs usual {r.pf:.0f} -> x{r.f:.3f}")
    return res
