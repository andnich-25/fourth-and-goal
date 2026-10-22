"""The college football game model: ratings -> expected score -> 5,000-game simulation.

1. Before every week, four sets of opponent-adjusted ratings are refit on earlier games only (ratings.py): points,
   yards per play, plays (pace) and turnovers.
2. A second step turns those ratings and the posted line into an expected margin and an expected total. It is a
   ridge regression refit every week on games it never saw rated in advance; a game's weight halves every
   RECENCY_HALF_LIFE seasons, so the last two seasons count most. Because the posted line is one of its inputs, the
   model only moves off the line where the ratings have earned it in testing.
3. Each game is then played 5,000 times: the expected home and away points plus a pair of real misses (how far a
   past prediction was from the final, for both teams together) drawn from the last two seasons. Scores are whole
   numbers, so pushes on whole-number lines happen as often as they really do. Every chance on the site (cover,
   over, team total, win) is the share of those 5,000 games.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

from . import ratings

RATINGS = (  # prefix, home column, away column, half-life (days), ridge penalty
    ("r", "home_points", "away_points", 120, 2.0),
    ("y", "home_ypp", "away_ypp", 120, 4.0),
    ("n", "home_plays", "away_plays", 120, 4.0),
    ("t", "home_to", "away_to", 120, 20.0),
)
RECENCY_HALF_LIFE = 2.0   # seasons
ALPHA = 10.0
SIMS = 5000
POOL_SEASONS = 2          # misses drawn from about the last two seasons of out-of-sample games
MIN_POOL = 1500


def week_key(g: pd.DataFrame) -> pd.Series:
    return g.season.astype(str) + "-" + g.season_type.astype(str) + "-" + g.week.astype(int).astype(str).str.zfill(2)


def rate(g: pd.DataFrame, first_season: int) -> pd.DataFrame:
    """Ratings for every game from first_season on (finished or not), each fit on games before that week only."""
    parts = []
    todo = g[g.season >= first_season]
    for _, grp in todo.groupby(week_key(todo), sort=True):
        now = grp.date.min() - pd.Timedelta(hours=6)
        cols = []
        for pre, hc, ac, hl, al in RATINGS:
            p = ratings.predict(ratings.fit(g, now, hl, al, hc, ac), grp, pre)
            cols.append(p if pre == "r" else p.drop(columns=["home_games", "away_games"]))
        parts.append(pd.concat(cols, axis=1))
    return pd.concat(parts) if parts else pd.DataFrame()


def _fill(d: pd.DataFrame, c: str, v: float) -> pd.Series:
    return d[c].fillna(v) if c in d else pd.Series(v, index=d.index)


def features(d: pd.DataFrame, kind: str) -> pd.DataFrame:
    ypp_h, ypp_a = _fill(d, "y_home", 5.6), _fill(d, "y_away", 5.6)
    n_h, n_a = _fill(d, "n_home", 70), _fill(d, "n_away", 70)
    absp = d.spread.abs()
    if kind == "margin":
        fav_home = d.spread < 0
        return pd.DataFrame({
            "line": -d.spread,
            "points": d.r_home - d.r_away,
            "yards": (ypp_h * n_h - ypp_a * n_a) / 10,
            "turnovers": _fill(d, "t_home", 1.5) - _fill(d, "t_away", 1.5),
            "home": (~d.neutral).astype(float),
            "short_dog": (absp <= 3.5).astype(float) * np.where(fav_home, -1.0, 1.0),
        }, index=d.index)
    return pd.DataFrame({
        "line": d.total,
        "points": d.r_home + d.r_away,
        "yards": (ypp_h * n_h + ypp_a * n_a) / 10,
        "plays": n_h + n_a,
        "high_total": (d.total - 60).clip(lower=0),
        "blowout": (absp >= 21).astype(float),
        "neutral": d.neutral.astype(float),
        "november": (d.date.dt.month >= 11).astype(float),
    }, index=d.index)


def _fit(train: pd.DataFrame, kind: str, season: int) -> Ridge:
    y = train.margin if kind == "margin" else train.pts
    w = 0.5 ** ((season - train.season) / RECENCY_HALF_LIFE)
    return Ridge(alpha=ALPHA).fit(features(train, kind), y, sample_weight=w)


def usable(g: pd.DataFrame) -> pd.Series:
    return g.spread.notna() & g.total.notna() & g.r_home.notna()


def walk_forward(g: pd.DataFrame, first_test: int, log=print) -> pd.DataFrame:
    """Expected margin and total for every finished game from first_test on, from a model refit every week on
    earlier games only. Returns the games with pred_margin, pred_total and the coefficient snapshot of the last fit."""
    ok = usable(g) & g.final
    test = g[ok & (g.season >= first_test)]
    out = []
    for wk, grp in test.groupby(week_key(test), sort=True):
        now = grp.date.min() - pd.Timedelta(hours=6)
        train = g[ok & (g.date < now)]
        season = int(grp.season.iloc[0])
        m = _fit(train, "margin", season)
        t = _fit(train, "total", season)
        out.append(grp.assign(pred_margin=m.predict(features(grp, "margin")),
                              pred_total=t.predict(features(grp, "total"))))
    r = pd.concat(out)
    r["pred_home"] = (r.pred_total + r.pred_margin) / 2
    r["pred_away"] = (r.pred_total - r.pred_margin) / 2
    r["miss_home"] = r.home_points - r.pred_home
    r["miss_away"] = r.away_points - r.pred_away
    log(f"cfb: walk-forward predictions for {len(r):,} games ({first_test}-{int(r.season.max())})")
    return r


def fit_live(g: pd.DataFrame, upcoming: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """Expected margin and total for games not yet played, from every finished game. Games without a posted line
    use the ratings-only projection (no line feature), labelled as such."""
    ok = usable(g) & g.final
    season = int(upcoming.season.max()) if len(upcoming) else int(g.season.max())
    train = g[ok]
    m, t = _fit(train, "margin", season), _fit(train, "total", season)
    u = upcoming.copy()
    has = u.spread.notna() & u.total.notna()
    u["pred_margin"] = np.nan
    u["pred_total"] = np.nan
    if has.any():
        u.loc[has, "pred_margin"] = m.predict(features(u[has], "margin"))
        u.loc[has, "pred_total"] = t.predict(features(u[has], "total"))
    if (~has).any():
        # no line yet: ratings alone (points model), so the game still gets a projection
        v = u[~has]
        u.loc[~has, "pred_margin"] = v.r_home - v.r_away
        u.loc[~has, "pred_total"] = v.r_home + v.r_away
    u["pred_home"] = (u.pred_total + u.pred_margin) / 2
    u["pred_away"] = (u.pred_total - u.pred_margin) / 2
    coefs = {"margin": dict(zip(features(train.head(1), "margin").columns, np.round(m.coef_, 4))),
             "total": dict(zip(features(train.head(1), "total").columns, np.round(t.coef_, 4)))}
    return u, coefs


# --------------------------------------------------------------------------- simulation
def miss_pool(oos: pd.DataFrame, before: pd.Timestamp) -> np.ndarray:
    """(home miss, away miss) pairs from out-of-sample games in about the last POOL_SEASONS seasons before `before`."""
    p = oos[oos.date < before].sort_values("date")
    recent = p[p.date >= before - pd.Timedelta(days=365 * POOL_SEASONS)]
    if len(recent) < MIN_POOL:
        recent = p.tail(MIN_POOL)
    return recent[["miss_home", "miss_away"]].to_numpy(float)


def simulate(pred_home: np.ndarray, pred_away: np.ndarray, pool: np.ndarray, n: int = SIMS,
             seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """n simulated final scores per game (games x n arrays of whole points, never below zero)."""
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(pool), size=(len(pred_home), n))
    h = np.rint(np.asarray(pred_home)[:, None] + pool[idx, 0])
    a = np.rint(np.asarray(pred_away)[:, None] + pool[idx, 1])
    return np.clip(h, 0, None), np.clip(a, 0, None)


def chances(h: np.ndarray, a: np.ndarray, spread: np.ndarray, total: np.ndarray, tt_home: np.ndarray,
            tt_away: np.ndarray) -> dict:
    """Win/loss/push shares for every market from simulated scores. Pushes are left out of the lean's chance the
    way a book refunds them: p = wins / (wins + losses)."""
    def side(x, line):
        line = np.asarray(line, float)[:, None]
        win = (x > line).mean(1)
        loss = (x < line).mean(1)
        with np.errstate(invalid="ignore", divide="ignore"):
            return win / (win + loss), 1 - win - loss
    margin = h - a
    cover, cover_push = side(margin, -np.asarray(spread, float))
    over, over_push = side(h + a, total)
    tth, _ = side(h, tt_home)
    tta, _ = side(a, tt_away)
    home_win = (margin > 0).mean(1) + 0.5 * (margin == 0).mean(1)   # ties go to overtime: a coin flip
    return {"p_home_cover": cover, "push_spread": cover_push, "p_over": over, "push_total": over_push,
            "p_home_tt_over": tth, "p_away_tt_over": tta, "p_home_win": home_win,
            "home_mean": h.mean(1), "away_mean": a.mean(1),
            "margin_q": np.percentile(margin, [10, 50, 90], axis=1).T, "total_q": np.percentile(h + a, [10, 50, 90], axis=1).T}


def implied_team_total(spread: pd.Series, total: pd.Series, side: str) -> pd.Series:
    """The team total books hang is about half the total minus half the spread; they post it on a half point."""
    raw = (total - spread) / 2 if side == "home" else (total + spread) / 2
    return np.floor(raw) + 0.5
