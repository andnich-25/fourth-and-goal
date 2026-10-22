"""Same-game correlation for parlays, learned from walk-forward predictions and checked on unseen weeks.

Every leg the parlay builder offers is a yes/no event with a validated chance: an anytime TD (the promoted TD
model) or a prop over at a line (a promoted prop market). Legs from different games are treated as independent.
Legs from the same game are linked by a Gaussian copula: each leg hits when a standard-normal draw falls below
the normal quantile of its chance, and the draws of two legs share a correlation rho that depends on how the
legs are related (same player, teammates, opponents) and on their markets and positions.

rho is estimated by maximum likelihood from pairs of walk-forward predictions (each made from earlier games
only) and their outcomes, with each bucket shrunk toward its parent bucket. The estimate for test week W uses
only pairs from weeks before W, so the validation below is out of sample. A copula is only used on the site if
it beats the independence product on unseen weeks; otherwise the builder multiplies chances and says so.
"""
from __future__ import annotations

import json
import sqlite3
import uuid

import numpy as np
import pandas as pd
from scipy.stats import norm

from .props import latest_report
from .predict import latest_gate
from .util import utcnow

GRID = np.round(np.arange(-0.60, 0.901, 0.01), 2)
PRIOR_SD = {"root": 0.30, "parent": 0.15, "leaf": 0.10}
MIN_TRAIN_WEEKS = 3
TRIPLES_PER_WEEK = 400
SIM_DRAWS = 4000
_GL_X, _GL_W = np.polynomial.legendre.leggauss(16)


# --------------------------------------------------------------------------- bivariate normal
def bvn_cdf(h: np.ndarray, k: np.ndarray, rho: float | np.ndarray) -> np.ndarray:
    """P(X < h, Y < k) for standard normals with correlation rho (Plackett's identity, Gauss-Legendre in rho)."""
    h, k, rho = np.broadcast_arrays(np.asarray(h, float), np.asarray(k, float), np.asarray(rho, float))
    r = rho[..., None] * (_GL_X + 1) / 2  # nodes on [0, rho]
    s = np.sqrt(1 - r ** 2)
    dens = np.exp(-(h[..., None] ** 2 - 2 * r * h[..., None] * k[..., None] + k[..., None] ** 2) / (2 * s ** 2)) / (2 * np.pi * s)
    return norm.cdf(h) * norm.cdf(k) + rho / 2 * (dens * _GL_W).sum(-1)


def p_both(pa: np.ndarray, pb: np.ndarray, rho) -> np.ndarray:
    pa, pb = np.clip(pa, 1e-4, 1 - 1e-4), np.clip(pb, 1e-4, 1 - 1e-4)
    p11 = bvn_cdf(norm.ppf(pa), norm.ppf(pb), rho)
    return np.clip(p11, np.maximum(0, pa + pb - 1) + 1e-9, np.minimum(pa, pb) - 1e-9)


# --------------------------------------------------------------------------- events
def load_events(c: sqlite3.Connection) -> tuple[pd.DataFrame, dict]:
    """Walk-forward yes/no events: anytime TD from the promoted TD model, overs at the reference line from promoted prop markets."""
    gate, prep = latest_gate(c), latest_report(c)
    if not gate or not gate.get("promoted"):
        raise RuntimeError("No promoted TD model; run the backtest first.")
    td = pd.read_sql_query(
        "SELECT season, week, player_id, team, position, p, outcome AS y FROM backtest_preds "
        "WHERE run_id=? AND model=? AND pregame_eligible=1 AND outcome IS NOT NULL", c, params=(gate["run_id"], gate["promoted"]))
    td["market"] = "td"
    parts, markets = [td], {"td": gate["promoted"]}
    for market, rep in ((prep or {}).get("markets") or {}).items():
        model = rep["gate"]["promoted"]
        if not model:
            continue
        pb = pd.read_sql_query(
            "SELECT season, week, player_id, team, position, p_over AS p, (actual > line) AS y FROM prop_backtest "
            "WHERE run_id=? AND market=? AND model=? AND actual IS NOT NULL", c, params=(prep["run_id"], market, model))
        pb["market"] = market
        parts.append(pb)
        markets[market] = model
    ev = pd.concat(parts, ignore_index=True)
    games = pd.read_sql_query("SELECT game_id, season, week, home_team, away_team FROM games", c)
    side = pd.concat([games.rename(columns={"home_team": "team", "away_team": "opponent"}),
                      games.rename(columns={"away_team": "team", "home_team": "opponent"})])[["season", "week", "team", "opponent", "game_id"]]
    ev = ev.merge(side, on=["season", "week", "team"], how="inner")
    ev["y"] = ev.y.astype(int)
    ev["p"] = ev.p.clip(0.005, 0.995)
    return ev.reset_index(drop=True), {"td_run": gate["run_id"], "prop_run": (prep or {}).get("run_id"), "models": markets}


# --------------------------------------------------------------------------- buckets
def keys_for(rel: str, ma: str, pa: str, mb: str, pb: str) -> tuple[str, str, str]:
    """(leaf, parent, root) bucket names for a pair of legs; order-free."""
    if rel == "player":
        m1, m2 = sorted([ma, mb])
        return f"player|{m1}|{m2}", f"player|{m1}|{m2}", "player"
    (m1, p1), (m2, p2) = sorted([(ma, pa), (mb, pb)])
    return f"{rel}|{m1}.{p1}|{m2}.{p2}", f"{rel}|{m1}|{m2}", rel


def pairs(ev: pd.DataFrame) -> pd.DataFrame:
    """Every pair of events from the same game (same player, teammates, or opponents)."""
    out = []
    for _, g in ev.groupby("game_id", sort=False):
        idx = g.index.to_numpy()
        if len(idx) < 2:
            continue
        a, b = np.triu_indices(len(idx), 1)
        out.append(np.column_stack([idx[a], idx[b]]))
    ij = np.vstack(out)
    A, B = ev.loc[ij[:, 0]].reset_index(drop=True), ev.loc[ij[:, 1]].reset_index(drop=True)
    same_market_player = (A.player_id == B.player_id) & (A.market == B.market)
    rel = np.where(A.player_id == B.player_id, "player", np.where(A.team == B.team, "team", "opp"))
    P = pd.DataFrame({"i": ij[:, 0], "j": ij[:, 1], "season": A.season, "week": A.week, "game_id": A.game_id, "rel": rel,
                      "pa": A.p, "pb": B.p, "ya": A.y, "yb": B.y})
    k = [keys_for(r, ma, pa, mb, pb) for r, ma, pa, mb, pb in zip(rel, A.market, A.position, B.market, B.position)]
    P["leaf"], P["parent"], P["root"] = zip(*k)
    return P[~same_market_player.to_numpy()].reset_index(drop=True)


def pair_loglik(P: pd.DataFrame) -> np.ndarray:
    """Log-likelihood of each pair's (hit, hit) outcome at every rho on the grid: shape (pairs, grid)."""
    return np.vstack([_pair_loglik(P.iloc[i:i + 5000]) for i in range(0, len(P), 5000)])


def _pair_loglik(P: pd.DataFrame) -> np.ndarray:
    pa, pb = P.pa.to_numpy()[:, None], P.pb.to_numpy()[:, None]
    p11 = p_both(np.repeat(pa, len(GRID), 1), np.repeat(pb, len(GRID), 1), GRID[None, :])
    ya, yb = P.ya.to_numpy()[:, None], P.yb.to_numpy()[:, None]
    prob = np.where(ya & yb, p11, np.where(ya == 1, pa - p11, np.where(yb == 1, pb - p11, 1 - pa - pb + p11)))
    return np.log(np.clip(prob, 1e-12, 1))


def _posterior(ll: np.ndarray, center: float, sd: float) -> tuple[float, float]:
    lp = ll - (GRID - center) ** 2 / (2 * sd ** 2)
    w = np.exp(lp - lp.max())
    w /= w.sum()
    m = float((w * GRID).sum())
    return m, float(np.sqrt((w * (GRID - m) ** 2).sum()))


def estimate(P: pd.DataFrame, LL: np.ndarray) -> dict:
    """Shrunk rho per bucket: root toward 0, parent toward root, leaf toward parent."""
    out = {}
    for level, center_of, sd in (("root", None, PRIOR_SD["root"]), ("parent", "root", PRIOR_SD["parent"]),
                                 ("leaf", "parent", PRIOR_SD["leaf"])):
        for key, idx in P.groupby(level).indices.items():
            if key in out:  # player buckets share a name across levels
                continue
            center = 0.0 if center_of is None else out[P[center_of].iloc[idx[0]]]["rho"]
            m, sd_post = _posterior(LL[idx].sum(0), center, sd)
            out[key] = {"rho": round(m, 3), "sd": round(sd_post, 3), "pairs": int(len(idx)),
                        "both_hit": int((P.ya.iloc[idx] & P.yb.iloc[idx]).sum())}
    return out


def rho_lookup(buckets: dict, leaf: str, parent: str, root: str) -> float:
    for k in (leaf, parent, root):
        if k in buckets:
            return buckets[k]["rho"]
    return 0.0


# --------------------------------------------------------------------------- validation
def _logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def _sim_joint(p: np.ndarray, R: np.ndarray, z: np.ndarray) -> float:
    w, V = np.linalg.eigh(R)
    L = V * np.sqrt(np.clip(w, 1e-6, None))
    x = z @ L.T
    return float((x < norm.ppf(p)).all(1).mean())


def walk_forward(ev: pd.DataFrame, P: pd.DataFrame, LL: np.ndarray, seed=7, log=print) -> pd.DataFrame:
    """Joint-hit chances for same-game pairs and triples in each test week, with rho fit on earlier weeks only."""
    order = sorted(set(zip(P.season, P.week)))
    wk = list(zip(P.season, P.week))
    rng = np.random.default_rng(seed)
    z = rng.standard_normal((SIM_DRAWS, 3))
    ev_t = ev.set_index(ev.index)
    rows = []
    for n, (s, w) in enumerate(order):
        if n < MIN_TRAIN_WEEKS:
            continue
        train = np.array([(a, b) < (s, w) for a, b in wk])
        test = np.array([(a, b) == (s, w) for a, b in wk])
        buckets = estimate(P[train].reset_index(drop=True), LL[train])
        T = P[test]
        rho = np.array([rho_lookup(buckets, a, b, c_) for a, b, c_ in zip(T.leaf, T.parent, T.root)])
        cop = p_both(T.pa.to_numpy(), T.pb.to_numpy(), rho)
        rows.append(pd.DataFrame({"season": s, "week": w, "legs": 2, "rel": T.rel.to_numpy(), "y": (T.ya & T.yb).to_numpy(),
                                  "p_ind": (T.pa * T.pb).to_numpy(), "p_cop": cop}))
        # triples: random same-game triples, joint chance by simulation
        tw = ev_t[(ev_t.season == s) & (ev_t.week == w)]
        groups = [g.index.to_numpy() for _, g in tw.groupby("game_id") if len(g) >= 3]
        trip = []
        for _ in range(TRIPLES_PER_WEEK):
            g = groups[rng.integers(len(groups))]
            pick = rng.choice(g, 3, replace=False)
            r = tw.loc[pick]
            R = np.eye(3)
            for a in range(3):
                for b in range(a + 1, 3):
                    ra, rb = r.iloc[a], r.iloc[b]
                    rel = "player" if ra.player_id == rb.player_id else ("team" if ra.team == rb.team else "opp")
                    R[a, b] = R[b, a] = rho_lookup(buckets, *keys_for(rel, ra.market, ra.position, rb.market, rb.position))
            p = r.p.to_numpy()
            trip.append((int(r.y.all()), float(np.prod(p)), _sim_joint(p, R, z)))
        if trip:
            t = np.array(trip)
            rows.append(pd.DataFrame({"season": s, "week": w, "legs": 3, "rel": "mixed", "y": t[:, 0].astype(int),
                                      "p_ind": t[:, 1], "p_cop": t[:, 2]}))
        log(f"correlation walk-forward {s} W{w}: {int(test.sum())} pairs, {len(trip)} triples")
    return pd.concat(rows, ignore_index=True)


def _summary(V: pd.DataFrame, reps=500, seed=11) -> dict:
    V = V.assign(ll_ind=_logloss(V.y, V.p_ind), ll_cop=_logloss(V.y, V.p_cop),
                 br_ind=(V.y - V.p_ind) ** 2, br_cop=(V.y - V.p_cop) ** 2)
    wk = V.groupby(["season", "week"])[["ll_ind", "ll_cop"]].agg(["sum", "count"])
    gain_w = (wk[("ll_ind", "sum")] - wk[("ll_cop", "sum")]).to_numpy()
    cnt_w = wk[("ll_ind", "count")].to_numpy()
    rng = np.random.default_rng(seed)
    boots = []
    for _ in range(reps):
        i = rng.integers(len(gain_w), size=len(gain_w))
        boots.append(gain_w[i].sum() / cnt_w[i].sum())
    lo, hi = np.percentile(boots, [2.5, 97.5])
    cal = []
    for lo_, hi_ in ((0, .02), (.02, .05), (.05, .1), (.1, .2), (.2, .35), (.35, 1.01)):
        for col in ("p_ind", "p_cop"):
            m = (V[col] >= lo_) & (V[col] < hi_)
            cal.append({"bin": f"{lo_:.2f}-{min(hi_, 1):.2f}", "method": "independent" if col == "p_ind" else "correlated",
                        "n": int(m.sum()), "predicted": float(V.loc[m, col].mean()) if m.any() else None,
                        "observed": float(V.loc[m, "y"].mean()) if m.any() else None})
    return {"n": int(len(V)), "weeks": int(len(gain_w)), "both_hit_rate": float(V.y.mean()),
            "independent": {"log_loss": float(V.ll_ind.mean()), "brier": float(V.br_ind.mean()), "mean_p": float(V.p_ind.mean())},
            "correlated": {"log_loss": float(V.ll_cop.mean()), "brier": float(V.br_cop.mean()), "mean_p": float(V.p_cop.mean())},
            "log_loss_gain": float(V.ll_ind.mean() - V.ll_cop.mean()), "gain_ci": [float(lo), float(hi)], "calibration": cal}


def evaluate(V: pd.DataFrame, latest_season: int) -> dict:
    out = {"pairs": _summary(V[V.legs == 2]), "triples": _summary(V[V.legs == 3]),
           "by_relation": {r: _summary(V[(V.legs == 2) & (V.rel == r)]) for r in ("player", "team", "opp")},
           "latest_season_pairs": _summary(V[(V.legs == 2) & (V.season == latest_season)])}
    checks = [
        {"check": "Same-game pairs: correlated beats independent on log loss (week-bootstrap 95% CI above 0)",
         "value": out["pairs"]["gain_ci"], "pass": out["pairs"]["gain_ci"][0] > 0},
        {"check": "Same-game triples: correlated not worse than independent", "value": out["triples"]["log_loss_gain"],
         "pass": out["triples"]["log_loss_gain"] >= 0},
        {"check": f"{latest_season} pairs: correlated not worse than independent", "value": out["latest_season_pairs"]["log_loss_gain"],
         "pass": out["latest_season_pairs"]["log_loss_gain"] >= 0},
        {"check": "At least 10 test weeks", "value": out["pairs"]["weeks"], "pass": out["pairs"]["weeks"] >= 10},
    ]
    out["gate"] = {"checks": checks, "passed": all(c_["pass"] for c_ in checks)}
    return out


# --------------------------------------------------------------------------- run
def run(c: sqlite3.Connection, log=print) -> dict:
    ev, src = load_events(c)
    P = pairs(ev)
    log(f"correlation: {len(ev):,} walk-forward events, {len(P):,} same-game pairs")
    LL = pair_loglik(P)
    V = walk_forward(ev, P, LL, log=log)
    rep = evaluate(V, int(ev.season.max()))
    buckets = estimate(P, LL)  # all weeks, for the upcoming week
    run_id = "cor-" + uuid.uuid4().hex[:10]
    report = {"run_id": run_id, "created_at": utcnow(), "source": src, "events": int(len(ev)), "pairs": int(len(P)),
              "method": "Gaussian copula; rho by maximum likelihood on walk-forward pairs, shrunk leaf -> parent -> root -> 0",
              "prior_sd": PRIOR_SD, "use_correlation": rep["gate"]["passed"], "validation": rep, "buckets": buckets}
    with c:
        c.execute("INSERT INTO sim_runs VALUES (?,?,?,?)", (run_id, "correlation", report["created_at"], json.dumps(report)))
    log(f"correlation: pairs log-loss gain {rep['pairs']['log_loss_gain']:.5f} CI {rep['pairs']['gain_ci']}, "
        f"triples gain {rep['triples']['log_loss_gain']:.5f}, used={rep['gate']['passed']}")
    return report


def latest(c: sqlite3.Connection) -> dict | None:
    r = c.execute("SELECT report FROM sim_runs WHERE kind='correlation' ORDER BY created_at DESC LIMIT 1").fetchone()
    return json.loads(r["report"]) if r else None
