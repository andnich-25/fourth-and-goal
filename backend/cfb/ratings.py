"""Opponent-adjusted team ratings, refit before every week.

Each team-game says: points scored = league base + this team's offense - the opponent's defense + home edge (zero at
neutral sites). The ratings solve that for every team at once with a ridge penalty that pulls little-seen teams to
average, and older games count less: a game's weight halves every HALF_LIFE_DAYS. With the off-season in between, last
season's games still count (about a third as much by September), so early-season ratings start from last year's team
and move as new games come in.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

HALF_LIFE_DAYS = 120
WINDOW_DAYS = 900        # about the last two and a half seasons
ALPHA = 2.0


def fit(train: pd.DataFrame, now: pd.Timestamp, half_life: float = HALF_LIFE_DAYS, alpha: float = ALPHA,
        home_col: str = "home_points", away_col: str = "away_points") -> dict:
    """Ratings from finished games before `now`. Returns offense/defense by team id, home edge and base. Any per-side
    number works the same way (yards per play, plays): pass its home and away columns."""
    t = train[train.final & (train.date < now) & (train.date >= now - pd.Timedelta(days=WINDOW_DAYS))]
    t = t[t[home_col].notna() & t[away_col].notna()]
    teams = pd.unique(np.r_[t.home_id.to_numpy(), t.away_id.to_numpy()])
    idx = {tm: i for i, tm in enumerate(teams)}
    T = len(teams)
    n = len(t)
    if n == 0:
        return {"off": {}, "def": {}, "home": 2.5, "base": 28.0, "games": {}}
    w = 0.5 ** ((now - t.date).dt.days.to_numpy() / half_life)
    h = t.home_id.map(idx).to_numpy()
    a = t.away_id.map(idx).to_numpy()
    hm = np.where(t.neutral.to_numpy(), 0.0, 1.0)
    # rows: home scoring, away scoring; columns: offense (T), defense (T), home edge, base
    off = np.r_[h, a]
    de = np.r_[a, h]
    side = np.r_[hm, -hm]
    y = np.r_[t[home_col].to_numpy(float), t[away_col].to_numpy(float)]
    W = np.r_[w, w]
    P = 2 * T + 2
    A = np.zeros((P, P))
    b = np.zeros(P)
    # accumulate X'WX for the sparse design without building it
    np.add.at(A, (off, off), W)
    np.add.at(A, (de + T, de + T), W)
    np.add.at(A, (off, de + T), -W)
    np.add.at(A, (de + T, off), -W)
    for col, vals in ((2 * T, side), (2 * T + 1, np.ones_like(side))):
        np.add.at(A, (off, col), W * vals)
        np.add.at(A, (de + T, col), -W * vals)
        A[col, :2 * T] = A[:2 * T, col]
    A[2 * T, 2 * T] = np.sum(W * side * side)
    A[2 * T, 2 * T + 1] = A[2 * T + 1, 2 * T] = np.sum(W * side)
    A[2 * T + 1, 2 * T + 1] = np.sum(W)
    np.add.at(b, off, W * y)
    np.add.at(b, de + T, -W * y)
    b[2 * T] = np.sum(W * side * y)
    b[2 * T + 1] = np.sum(W * y)
    A[np.arange(2 * T), np.arange(2 * T)] += alpha
    coef = np.linalg.solve(A, b)
    recent = t[t.date >= now - pd.Timedelta(days=200)]
    games = pd.concat([recent.home_id, recent.away_id]).value_counts().to_dict()
    return {"off": dict(zip(teams, coef[:T])), "def": dict(zip(teams, coef[T:2 * T])), "home": float(coef[2 * T]),
            "base": float(coef[2 * T + 1]), "games": games}


def predict(r: dict, games: pd.DataFrame, prefix: str = "r") -> pd.DataFrame:
    """Expected points for each side of each game. Unknown teams (new to FBS, Division II) get a below-average
    rating: the average of teams with few games."""
    low_o = np.percentile(list(r["off"].values()), 10) if r["off"] else 0.0
    low_d = np.percentile(list(r["def"].values()), 10) if r["def"] else 0.0
    o = lambda tm: r["off"].get(tm, low_o)   # noqa: E731
    d = lambda tm: r["def"].get(tm, low_d)   # noqa: E731
    hm = np.where(games.neutral.to_numpy(), 0.0, r["home"])
    ph = r["base"] + games.home_id.map(o).to_numpy(float) - games.away_id.map(d).to_numpy(float) + hm
    pa = r["base"] + games.away_id.map(o).to_numpy(float) - games.home_id.map(d).to_numpy(float) - hm
    out = pd.DataFrame({f"{prefix}_home": ph, f"{prefix}_away": pa}, index=games.index)
    out["home_games"] = games.home_id.map(lambda t: r["games"].get(t, 0)).to_numpy()
    out["away_games"] = games.away_id.map(lambda t: r["games"].get(t, 0)).to_numpy()
    return out
