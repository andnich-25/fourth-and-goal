"""Versioned anytime-TD predictors and baselines.

fg-structural-1  team TD expectation -> player share -> opponent adjustment -> P(1+ TD),
                 with Poisson link 1-exp(-lambda) and isotonic calibration fit on earlier weeks.
fg-logit-1       logistic regression benchmark on the same pregame features.
fg-gbm-1         gradient-boosted trees benchmark.
baseline-position-rate      league anytime-TD rate for the position.
baseline-shrunk-player-rate the player's own anytime rate shrunk toward the position rate.
baseline-opportunity        rank only: carries + targets per game (no probability).

All `fit` calls receive training rows whose features were themselves built from games
before each row's week, and the training window always ends before the predicted week.
"""
from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

EPS = 1e-4
POS_PRIOR_SHARE = {"RB": 0.12, "WR": 0.07, "TE": 0.06, "QB": 0.05}
SHARE_SHRINK_GAMES = 2.0


def _fill(df: pd.DataFrame) -> pd.DataFrame:
    d = df.copy()
    for col in ["carries_pg", "targets_pg", "rz_carries_pg", "goal10_carries_pg", "goal5_carries_pg", "rz_targets_pg",
                "goal10_targets_pg", "ez_proxy_pg", "td_pg", "eff_games", "n_games_window", "n_games_cur", "changed_team",
                "missed_team_games"]:
        d[col] = pd.to_numeric(d.get(col), errors="coerce").fillna(0.0)
    d["opp_def_pos_mult"] = pd.to_numeric(d.get("opp_def_pos_mult"), errors="coerce").fillna(1.0)
    d["opp_def_pos_xtd_mult"] = pd.to_numeric(d.get("opp_def_pos_xtd_mult"), errors="coerce").fillna(1.0)
    d["snap_pct"] = pd.to_numeric(d.get("snap_pct"), errors="coerce")
    d["snap_known"] = d.snap_pct.notna().astype(float)
    d["snap_pct"] = d.snap_pct.fillna(d.snap_pct.median() if d.snap_pct.notna().any() else 0.5)
    share = pd.to_numeric(d.get("xtd_share"), errors="coerce")
    d["share_known"] = share.notna().astype(float)
    d["xtd_share_f"] = share.fillna(pd.to_numeric(d.get("opp_share"), errors="coerce")).fillna(0.0)
    # xTD is unavailable only where no earlier season existed to learn conversion rates; fall back to
    # red-zone volume so the row is not silently zeroed.
    d["xtd_pg_f"] = pd.to_numeric(d.get("xtd_pg"), errors="coerce").fillna(0.12 * d.rz_carries_pg + 0.15 * d.rz_targets_pg)
    return d


class StructuralModel:
    version = "fg-structural-1"

    def __init__(self, beta: float = 0.5, td_per_point: float | None = None):
        self.beta = beta
        self.td_per_point = td_per_point
        self.iso: IsotonicRegression | None = None
        self.league_td_pg = 2.4

    def _team_exp(self, d: pd.DataFrame) -> np.ndarray:
        implied = pd.to_numeric(d.team_implied_total, errors="coerce")
        fallback = pd.to_numeric(d.team_td_pg, errors="coerce").fillna(self.league_td_pg)
        return np.where(implied.notna(), implied * self.td_per_point, fallback)

    def lam(self, df: pd.DataFrame) -> np.ndarray:
        d = _fill(df)
        prior = d.position.map(POS_PRIOR_SHARE).fillna(0.05)
        n = d.eff_games
        share = (n * d.xtd_share_f + SHARE_SHRINK_GAMES * prior * 0.5) / (n + SHARE_SHRINK_GAMES)
        share = np.where(d.n_games_window > 0, share, prior * 0.25)
        mult = np.clip(d.opp_def_pos_mult, 0.5, 2.0) ** self.beta
        return np.clip(self._team_exp(d) * share * mult, 1e-4, 3.0)

    def fit(self, train: pd.DataFrame, team_games: pd.DataFrame | None = None):
        if team_games is not None and len(team_games):
            tg = team_games.dropna(subset=["implied_total"])
            self.td_per_point = float(tg.offensive_tds.sum() / tg.implied_total.sum()) if len(tg) else 0.105
            self.league_td_pg = float(team_games.offensive_tds.mean())
        if self.td_per_point is None:
            self.td_per_point = 0.105
        y = train.scored_anytime.values.astype(int)
        best = None
        for beta in (0.0, 0.5, 1.0):
            self.beta = beta
            p = 1 - np.exp(-self.lam(train))
            ll = _logloss(y, p)
            if best is None or ll < best[0]:
                best = (ll, beta)
        self.beta = best[1]
        raw = 1 - np.exp(-self.lam(train))
        self.iso = IsotonicRegression(y_min=0.005, y_max=0.95, out_of_bounds="clip").fit(raw, y)
        return self

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        raw = 1 - np.exp(-self.lam(df))
        return np.clip(self.iso.predict(raw), EPS, 1 - EPS) if self.iso is not None else raw

    def params(self) -> dict:
        return {"beta": self.beta, "td_per_point": self.td_per_point, "league_td_pg": self.league_td_pg,
                "share_shrink_games": SHARE_SHRINK_GAMES, "calibration": "isotonic on earlier-week predictions"}


ML_FEATURES = ["log_lam", "carries_pg", "targets_pg", "rz_carries_pg", "goal10_carries_pg", "goal5_carries_pg",
               "rz_targets_pg", "goal10_targets_pg", "ez_proxy_pg", "xtd_pg_f", "xtd_share_f", "anytime_rate_shrunk",
               "implied", "opp_def_pos_mult", "opp_def_pos_xtd_mult", "snap_pct", "snap_known", "share_known",
               "n_games_cur", "changed_team", "is_rb", "is_wr", "is_te", "is_qb"]


def _ml_matrix(df: pd.DataFrame, structural: StructuralModel) -> np.ndarray:
    d = _fill(df)
    d["log_lam"] = np.log(structural.lam(df))
    d["implied"] = pd.to_numeric(d.team_implied_total, errors="coerce").fillna(22.0)
    d["anytime_rate_shrunk"] = pd.to_numeric(d.anytime_rate_shrunk, errors="coerce").fillna(0.15)
    for p in ("RB", "WR", "TE", "QB"):
        d[f"is_{p.lower()}"] = (d.position == p).astype(float)
    return d[ML_FEATURES].astype(float).values


class LogitModel:
    version = "fg-logit-1"

    def fit(self, train, team_games=None):
        self.struct = StructuralModel().fit(train, team_games)
        self.clf = make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=2000))
        self.clf.fit(_ml_matrix(train, self.struct), train.scored_anytime.values.astype(int))
        return self

    def predict(self, df):
        return np.clip(self.clf.predict_proba(_ml_matrix(df, self.struct))[:, 1], EPS, 1 - EPS)

    def params(self):
        return {"features": ML_FEATURES, "C": 0.5}


class GBMModel:
    version = "fg-gbm-1"

    def fit(self, train, team_games=None):
        self.struct = StructuralModel().fit(train, team_games)
        self.clf = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=250, min_samples_leaf=40,
                                                  l2_regularization=1.0, random_state=7)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.clf.fit(_ml_matrix(train, self.struct), train.scored_anytime.values.astype(int))
        return self

    def predict(self, df):
        return np.clip(self.clf.predict_proba(_ml_matrix(df, self.struct))[:, 1], EPS, 1 - EPS)

    def params(self):
        return {"features": ML_FEATURES, "max_depth": 3, "learning_rate": 0.05, "max_iter": 250}


class PositionRateBaseline:
    version = "baseline-position-rate"

    def fit(self, train, team_games=None):
        self.rates = train.groupby("position").scored_anytime.mean().to_dict()
        self.overall = float(train.scored_anytime.mean())
        return self

    def predict(self, df):
        return np.clip(df.position.map(self.rates).fillna(self.overall).values.astype(float), EPS, 1 - EPS)

    def params(self):
        return {"rates": self.rates}


class ShrunkRateBaseline:
    version = "baseline-shrunk-player-rate"

    def fit(self, train, team_games=None):
        return self

    def predict(self, df):
        return np.clip(pd.to_numeric(df.anytime_rate_shrunk, errors="coerce").fillna(0.15).values, EPS, 1 - EPS)

    def params(self):
        return {"shrink_games": 4, "toward": "position anytime rate"}


def opportunity_score(df: pd.DataFrame) -> np.ndarray:
    d = _fill(df)
    return (d.carries_pg + d.targets_pg).values


CANDIDATES = {"fg-structural-1": StructuralModel, "fg-logit-1": LogitModel, "fg-gbm-1": GBMModel}
BASELINES = {"baseline-position-rate": PositionRateBaseline, "baseline-shrunk-player-rate": ShrunkRateBaseline}


def _logloss(y, p):
    p = np.clip(p, EPS, 1 - EPS)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
