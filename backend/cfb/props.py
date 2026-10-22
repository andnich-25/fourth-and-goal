"""College football player props: passing, rushing and receiving yards and receptions.

Books post these for the big games only, so the site shows them for featured games (both teams ranked or rated top
25, or a book has posted props for the game).

Projection for a player in a game = his recent level x how much the opponent gives up in that stat x how many points
his team is expected to score (from the game model). Recent level is an exponentially weighted average of his earlier
games (half-life HALF_LIFE_GAMES; last season's games count half). The exponents on the opponent and team-points
factors are fit on earlier seasons only, and the spread of outcomes around the projection is the real spread of
earlier games (ratio of result to projection), so a 70-yard projection can come in at 20 or 150 as often as it
really does. Historical book prop lines are not freely available for college football, so the backtest scores the
player's usual line (median of his last five games, on a half point); hit rates on posted lines come from the live
record only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

from . import sources

MARKETS = {"pass_yds": "Passing yards", "rush_yds": "Rushing yards", "rec_yds": "Receiving yards", "receptions": "Receptions"}
VOLUME = {"pass_yds": ("pass_att", 15), "rush_yds": ("rush_att", 7), "rec_yds": ("receptions", 2.5), "receptions": ("receptions", 2.5)}
HALF_LIFE_GAMES = 4
MIN_GAMES = 3


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


def load_player_games(first: int, last: int = sources.CURRENT_SEASON) -> pd.DataFrame:
    frames = []
    for yr in range(first, last + 1):
        p = sources.raw_dir() / sources.local_name("player_box", yr)
        if p.exists():
            frames.append(pd.read_csv(p, low_memory=False))
    if not frames:
        return pd.DataFrame()
    p = pd.concat(frames, ignore_index=True)
    p = p[p.category.isin(["passing", "rushing", "receiving"])].copy()
    p["pass_att"] = _num(p["completions/passingAttempts"].astype(str).str.split("/").str[1])
    keep = {"passing": {"passingYards": "pass_yds", "passingTouchdowns": "pass_td", "pass_att": "pass_att"},
            "rushing": {"rushingYards": "rush_yds", "rushingAttempts": "rush_att"},
            "receiving": {"receivingYards": "rec_yds", "receptions": "receptions"}}
    out = None
    for cat, cols in keep.items():
        c = p[p.category == cat][["game_id", "season", "athlete_id", "athlete_name", "team_id", *cols]].rename(columns=cols)
        c = c.drop_duplicates(["game_id", "athlete_id"])
        out = c if out is None else out.merge(c, on=["game_id", "season", "athlete_id", "athlete_name", "team_id"], how="outer")
    for c in ("pass_yds", "pass_td", "pass_att", "rush_yds", "rush_att", "rec_yds", "receptions"):
        out[c] = _num(out[c]).fillna(0.0)
    out["game_id"] = out.game_id.astype("int64")
    return out


def attach_games(pg: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    """Date, opponent and expected team points for each player-game."""
    side = []
    for s, o in (("home", "away"), ("away", "home")):
        x = games[["game_id", "date", "season", f"{s}_id", f"{o}_id", f"{s}_team", f"{o}_team"]].rename(
            columns={f"{s}_id": "team_id", f"{o}_id": "opp_id", f"{s}_team": "team", f"{o}_team": "opp"})
        x["home"] = int(s == "home")
        x["exp_pts"] = games[f"pred_{s}"] if f"pred_{s}" in games else np.nan
        side.append(x)
    side = pd.concat(side)
    d = pg.drop(columns=["season"]).merge(side, on=["game_id", "team_id"], how="inner")
    return d.sort_values(["date", "game_id"]).reset_index(drop=True)


def _ewm_prior(d: pd.DataFrame, col: str, by: str) -> pd.Series:
    """Weighted average of each group's earlier games (this game excluded); last season's games count half."""
    vals = d[col].to_numpy(float)
    keys = d[by].to_numpy()
    seasons = d.season.to_numpy()
    out = np.full(len(d), np.nan)
    state: dict = {}
    k = 0.5 ** (1 / HALF_LIFE_GAMES)
    for i in range(len(d)):
        key = keys[i]
        st = state.get(key)
        if st is not None:
            num, den, n, ssn = st
            if seasons[i] != ssn:
                num, den, ssn = num * 0.5, den * 0.5, seasons[i]
            out[i] = num / den if den > 0 else np.nan
            state[key] = (num * k + vals[i], den * k + 1, n + 1, ssn)
        else:
            state[key] = (vals[i], 1.0, 1, seasons[i])
    return pd.Series(out, index=d.index)


def _count_prior(d: pd.DataFrame, by: str) -> pd.Series:
    return d.groupby(by).cumcount()


def features(d: pd.DataFrame) -> pd.DataFrame:
    """Pregame numbers for every player-game (all from earlier games only)."""
    d = d.copy()
    d["games_before"] = _count_prior(d, "athlete_id")
    for m in ("pass_yds", "rush_yds", "rec_yds", "receptions", "pass_att", "rush_att"):
        d[f"{m}_lvl"] = _ewm_prior(d, m, "athlete_id")
    # what each defense allows: team totals per game, weighted the same way, relative to the league
    team = d.groupby(["game_id", "date", "season", "team_id", "opp_id"], as_index=False)[["pass_yds", "rush_yds", "rec_yds", "receptions"]].sum()
    team = team.sort_values("date").reset_index(drop=True)
    for m in ("pass_yds", "rush_yds", "rec_yds", "receptions"):
        team[f"{m}_allow"] = _ewm_prior(team, m, "opp_id")
        lg = team[m].expanding().mean().shift(1)
        team[f"{m}_opp"] = team[f"{m}_allow"] / lg
    pts = d.groupby(["game_id", "team_id"]).exp_pts.first()
    d = d.merge(team[["game_id", "team_id"] + [f"{m}_opp" for m in ("pass_yds", "rush_yds", "rec_yds", "receptions")]],
                on=["game_id", "team_id"], how="left")
    # the team's usual points, to say whether tonight's expected score is above or below it
    tp = d.groupby(["game_id", "team_id", "date", "season"], as_index=False).exp_pts.first().sort_values("date")
    tp["team_pts_lvl"] = tp.groupby("team_id").exp_pts.transform(lambda s: s.shift(1).ewm(halflife=6, min_periods=1).mean())
    d = d.merge(tp[["game_id", "team_id", "team_pts_lvl"]], on=["game_id", "team_id"], how="left")
    del pts
    return d


def design(d: pd.DataFrame, m: str) -> pd.DataFrame:
    lvl = d[f"{m}_lvl"].clip(lower=0.5)
    return pd.DataFrame({
        "lvl": np.log(lvl),
        "opp": np.log(d[f"{m}_opp"].clip(0.5, 2).fillna(1.0)),
        "pts": np.log((d.exp_pts / d.team_pts_lvl).clip(0.5, 2).fillna(1.0)),
        "home": d.home.astype(float),
    }, index=d.index)


def eligible(d: pd.DataFrame, m: str) -> pd.Series:
    vol, floor = VOLUME[m]
    return (d.games_before >= MIN_GAMES) & (d[f"{vol}_lvl"] >= floor) & d[f"{m}_lvl"].notna()


def usual_line(d: pd.DataFrame, m: str) -> pd.Series:
    med = d.groupby("athlete_id")[m].transform(lambda s: s.shift(1).rolling(5, min_periods=3).median())
    return np.floor(med) + 0.5


def fit(train: pd.DataFrame, m: str) -> tuple[Ridge, np.ndarray]:
    t = train[eligible(train, m)]
    X = design(t, m)
    y = np.log(t[m].clip(lower=0) + 1)
    w = 0.5 ** ((t.season.max() - t.season) / 1.0)
    r = Ridge(alpha=1.0).fit(X, y, sample_weight=w)
    mu = np.expm1(r.predict(X)).clip(min=0.5)
    ratios = (t[m].to_numpy(float) + 1) / (mu + 1)
    return r, ratios


def project(r: Ridge, ratios: np.ndarray, d: pd.DataFrame, m: str) -> pd.DataFrame:
    mu = np.expm1(r.predict(design(d, m))).clip(min=0.5)
    return pd.DataFrame({"mu": mu}, index=d.index), ratios


def p_over(mu: np.ndarray, ratios: np.ndarray, line: np.ndarray) -> np.ndarray:
    """Chance of going over each line: the share of real outcome/projection ratios that would clear it."""
    rs = np.sort(ratios)
    need = (np.asarray(line, float) + 1) / (np.asarray(mu, float) + 1)
    return 1 - np.searchsorted(rs, need, side="right") / len(rs)


def walk_forward(d: pd.DataFrame, first_test: int, log=print) -> pd.DataFrame:
    """Projections for every eligible player-game from first_test on, each season fit on earlier seasons and each
    week's distribution from earlier games."""
    out = []
    for season in sorted(d.season.unique()):
        if season < first_test:
            continue
        train = d[d.season < season]
        test = d[d.season == season]
        for m in MARKETS:
            r, ratios = fit(train, m)
            t = test[eligible(test, m)]
            if not len(t):
                continue
            mu = np.expm1(r.predict(design(t, m))).clip(min=0.5)
            line = usual_line(d, m).loc[t.index]
            x = t[["game_id", "date", "season", "athlete_id", "athlete_name", "team", "opp", m]].rename(columns={m: "y"})
            x["market"] = m
            x["mu"] = mu
            x["line"] = line
            x["p_over"] = p_over(mu, ratios, line.fillna(0))
            out.append(x[x.line.notna()])
    r = pd.concat(out) if out else pd.DataFrame()
    log(f"cfb props: walk-forward projections for {len(r):,} player-games")
    return r
