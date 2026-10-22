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
# Recent seasons count more when a model learns: a game's weight halves every RECENCY_HALF_LIFE seasons of age
# (age measured from the newest training game). Chosen by engine/recency.py on early test seasons; None = equal weights.
RECENCY_HALF_LIFE: float | None = 2.0  # study: 2021-23 picked 2 seasons, 2024-26 confirmed (log loss 0.38813 vs 0.38825 equal)
# Second-stage recalibration of the logistic model: sigmoid(a * logit(p) + b) fit on the most recent 20% of training
# weeks predicted by a model trained on the earlier 80%. Corrects chances that run too high at the top end.
RECALIBRATE = False
# Top-end correction: chances above this knot ran high in walk-forward tests (predicted 56% vs 51% observed at 50%+).
# A logistic fit on logit(p) plus a hinge at the knot, learned only from earlier weeks' out-of-sample predictions,
# pulls them back. Knot chosen on 2021-23 from {0.3, 0.4, 0.5}; on 2024-26 it lowered log loss (0.38826 vs 0.38837)
# and the 50%+ group went from 57.5% predicted / 53.8% observed to 52.9% / 52.2%. None turns it off.
TOP_END_KNOT: float | None = 0.5
TOP_END_MIN_WEEKS = 8
POS_PRIOR_SHARE = {"RB": 0.12, "WR": 0.07, "TE": 0.06, "QB": 0.05}
SHARE_SHRINK_GAMES = 2.0


def recency_weights(df: pd.DataFrame, half_life: float | None = None) -> np.ndarray | None:
    h = RECENCY_HALF_LIFE if half_life is None else half_life
    if not h or "season" not in df or not len(df):
        return None
    t = df.season.to_numpy(float) + df.week.to_numpy(float) / 18.0
    w = 0.5 ** ((t.max() - t) / h)
    return w / w.mean()


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

    def __init__(self, beta: float = 0.5, td_per_point: float | None = None, half_life: float | None = None):
        self.half_life = half_life
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
        w = recency_weights(train, self.half_life)
        best = None
        for beta in (0.0, 0.5, 1.0):
            self.beta = beta
            p = 1 - np.exp(-self.lam(train))
            ll = _logloss(y, p, w)
            if best is None or ll < best[0]:
                best = (ll, beta)
        self.beta = best[1]
        raw = 1 - np.exp(-self.lam(train))
        self.iso = IsotonicRegression(y_min=0.005, y_max=0.95, out_of_bounds="clip").fit(raw, y, sample_weight=w)
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


EXTRA_DEFAULTS = {"opp_implied_total": 22.0, "spread_for": 0.0, "cur_td_rate": 0.18, "cur_xtd_pg": 0.0, "team_rz_trips_pg": 3.3,
                  "opp_def_rz_td_rate": 0.56, "opp_def_rz_trips_pg": 3.3, "opp_def_pos_l4_mult": 1.0}


def _ml_matrix(df: pd.DataFrame, structural: StructuralModel, features: list[str] | None = None) -> np.ndarray:
    d = _fill(df)
    for k, v in EXTRA_DEFAULTS.items():
        d[k] = pd.to_numeric(d.get(k), errors="coerce").fillna(v)
    d["rz_x_def"] = (d.rz_carries_pg + d.rz_targets_pg) * np.clip(d.opp_def_pos_mult, 0.5, 2.0)
    d["is_home"] = pd.to_numeric(d.get("is_home"), errors="coerce").fillna(0.5)
    d["log_lam"] = np.log(structural.lam(df))
    d["implied"] = pd.to_numeric(d.team_implied_total, errors="coerce").fillna(22.0)
    d["anytime_rate_shrunk"] = pd.to_numeric(d.anytime_rate_shrunk, errors="coerce").fillna(0.15)
    for p in ("RB", "WR", "TE", "QB"):
        d[f"is_{p.lower()}"] = (d.position == p).astype(float)
    return d[features or ML_FEATURES].astype(float).values


class LogitModel:
    version = "fg-logit-1"
    FEATURES = ML_FEATURES
    C = 0.5

    def __init__(self, features: list[str] | None = None, C: float | None = None, half_life: float | None = None,
                 recalibrate: bool | None = None):
        self.features = list(features or self.FEATURES)
        self.c = C if C is not None else self.C
        self.half_life = half_life
        self.recalibrate = RECALIBRATE if recalibrate is None else recalibrate
        self.platt = (1.0, 0.0)

    def fit(self, train, team_games=None):
        if self.recalibrate:
            wk = (train.season * 100 + train.week).to_numpy()
            cut = np.quantile(np.unique(wk), 0.8)
            early, late = train[wk <= cut], train[wk > cut]
            if len(late) > 1000 and len(early) > 1500:
                tg = team_games
                if tg is not None and len(tg):
                    tg = tg[(tg.season * 100 + tg.week) <= cut]
                inner = LogitModel(self.features, self.c, self.half_life, recalibrate=False).fit(early, tg)
                z = np.log(inner.predict(late) / (1 - inner.predict(late)))
                lr = LogisticRegression(C=1e4).fit(z[:, None], late.scored_anytime.values.astype(int))
                self.platt = (float(lr.coef_[0][0]), float(lr.intercept_[0]))
        self.struct = StructuralModel(half_life=self.half_life).fit(train, team_games)
        self.clf = make_pipeline(StandardScaler(), LogisticRegression(C=self.c, max_iter=2000))
        self.clf.fit(_ml_matrix(train, self.struct, self.features), train.scored_anytime.values.astype(int),
                     logisticregression__sample_weight=recency_weights(train, self.half_life))
        return self

    def predict(self, df):
        p = np.clip(self.clf.predict_proba(_ml_matrix(df, self.struct, self.features))[:, 1], EPS, 1 - EPS)
        a, b = self.platt
        if (a, b) != (1.0, 0.0):
            p = np.clip(1 / (1 + np.exp(-(a * np.log(p / (1 - p)) + b))), EPS, 1 - EPS)
        return p

    def params(self):
        return {"features": self.features, "C": self.c, "recency_half_life_seasons": self.half_life or RECENCY_HALF_LIFE,
                "recalibration": {"a": self.platt[0], "b": self.platt[1]} if self.recalibrate else None}


class GBMModel:
    version = "fg-gbm-1"

    def fit(self, train, team_games=None):
        self.struct = StructuralModel().fit(train, team_games)
        self.clf = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=250, min_samples_leaf=40,
                                                  l2_regularization=1.0, random_state=7)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.clf.fit(_ml_matrix(train, self.struct), train.scored_anytime.values.astype(int), sample_weight=recency_weights(train))
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


class TopEnd:
    """sigmoid(a * z + b * max(0, z - logit(knot)) + c) on z = logit(p), fit on earlier out-of-sample predictions."""

    def __init__(self, knot: float | None = None):
        self.knot = TOP_END_KNOT if knot is None else knot
        self.coef = None

    def _x(self, p):
        z = np.log(np.clip(p, EPS, 1 - EPS) / (1 - np.clip(p, EPS, 1 - EPS)))
        k = np.log(self.knot / (1 - self.knot))
        return np.c_[z, np.maximum(0.0, z - k)]

    def fit(self, p, y):
        p, y = np.asarray(p, float), np.asarray(y, int)
        if self.knot and len(set(y)) == 2:
            lr = LogisticRegression(C=1e4).fit(self._x(p), y)
            a, b = lr.coef_[0]
            self.coef = (float(a), float(max(b, -a)), float(lr.intercept_[0]))  # never decreasing above the knot
        return self

    def predict(self, p):
        p = np.asarray(p, float)
        if self.coef is None:
            return p
        a, b, c = self.coef
        x = self._x(p)
        return 1 / (1 + np.exp(-(a * x[:, 0] + b * x[:, 1] + c)))


def top_end_walk_forward(t: np.ndarray, p: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Each week's chances corrected by a TopEnd fit on all earlier weeks (t = season*100 + week; y may be NaN)."""
    out = np.asarray(p, float).copy()
    if not TOP_END_KNOT:
        return out
    lab = ~np.isnan(y)
    for wk in np.unique(t):
        prior = lab & (t < wk)
        if len(np.unique(t[prior])) >= TOP_END_MIN_WEEKS:
            m = t == wk
            out[m] = TopEnd().fit(p[prior], y[prior]).predict(p[m])
    return out


CANDIDATES = {"fg-structural-1": StructuralModel, "fg-logit-1": LogitModel, "fg-gbm-1": GBMModel}
BASELINES = {"baseline-position-rate": PositionRateBaseline, "baseline-shrunk-player-rate": ShrunkRateBaseline}


def _logloss(y, p, w=None):
    p = np.clip(p, EPS, 1 - EPS)
    return float(-np.average(y * np.log(p) + (1 - y) * np.log(1 - p), weights=w))
