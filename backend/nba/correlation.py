"""Same-game correlation for NBA parlays, learned from walk-forward predictions and checked on unseen months.

Same method as the NFL engine (engine/correlation.py): each leg is a yes/no event (an over at the usual line, from
out-of-sample predictions); legs in the same game share a Gaussian copula whose rho depends on the relation (same
player, teammates, opponents), the markets and the positions, estimated by maximum likelihood and shrunk
leaf -> parent -> root -> 0. NBA games produce far more pairs than NFL weeks, so the log-likelihood is accumulated
per bucket and month instead of per pair, and only players averaging 18+ minutes take part. The copula is used only if
it beats multiplying chances on unseen months.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np
import pandas as pd

from engine.correlation import GRID, PRIOR_SD, _pair_loglik, _posterior, _sim_joint, keys_for, p_both

MIN_MINUTES = 18
GAMES_PER_MONTH = 40     # same-game pairs are taken from a random sample of each month's games
TRIPLES_PER_MONTH = 400
MIN_TRAIN_MONTHS = 3


def events(oos: dict[str, pd.DataFrame]) -> pd.DataFrame:
    parts = []
    for market, r in oos.items():
        r = r[r.line.notna() & (r.min_l >= MIN_MINUTES)]
        parts.append(pd.DataFrame({"month": r.month.astype(str), "season": r.season, "game_id": r.game_id,
                                   "player_id": r.player_id, "team": r.team, "position": r.pos, "market": market,
                                   "p": r.p_over.clip(0.005, 0.995), "y": (r.y > r.line).astype(int)}))
    return pd.concat(parts, ignore_index=True)


def month_pairs(ev: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
    games = ev.game_id.unique()
    keep = rng.choice(games, min(GAMES_PER_MONTH, len(games)), replace=False)
    out = []
    for _, g in ev[ev.game_id.isin(keep)].groupby("game_id", sort=False):
        a, b = np.triu_indices(len(g), 1)
        A, B = g.iloc[a].reset_index(drop=True), g.iloc[b].reset_index(drop=True)
        rel = np.where(A.player_id == B.player_id, "player", np.where(A.team == B.team, "team", "opp"))
        k = [keys_for(r, ma, pa, mb, pb) for r, ma, pa, mb, pb in zip(rel, A.market, A.position, B.market, B.position)]
        P = pd.DataFrame({"rel": rel, "pa": A.p, "pb": B.p, "ya": A.y, "yb": B.y})
        P["leaf"], P["parent"], P["root"] = zip(*k) if k else ([], [], [])
        out.append(P)
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def bucket_ll(P: pd.DataFrame) -> dict[tuple[str, str], tuple[np.ndarray, int, int]]:
    """Summed log-likelihood over the grid, pair count and both-hit count for every (level, bucket)."""
    LL = np.vstack([_pair_loglik(P.iloc[i:i + 5000]) for i in range(0, len(P), 5000)])
    out = {}
    for level in ("root", "parent", "leaf"):
        for key, idx in P.groupby(level).indices.items():
            out[(level, key)] = (LL[idx].sum(0), len(idx), int((P.ya.iloc[idx] & P.yb.iloc[idx]).sum()))
    return out


def estimate(acc: dict) -> dict:
    out = {}
    parent_of = {}
    for level, center_level, sd in (("root", None, PRIOR_SD["root"]), ("parent", "root", PRIOR_SD["parent"]),
                                    ("leaf", "parent", PRIOR_SD["leaf"])):
        for (lv, key), (ll, n, both) in acc.items():
            if lv != level or key in out:
                continue
            if center_level is None:
                center = 0.0
            else:
                parts = key.split("|")
                if parts[0] == "player":
                    center = out.get("player", {"rho": 0.0})["rho"]
                elif level == "parent":
                    center = out.get(parts[0], {"rho": 0.0})["rho"]
                else:
                    pk = f"{parts[0]}|{parts[1].split('.')[0]}|{parts[2].split('.')[0]}"
                    center = out.get(pk, {"rho": 0.0})["rho"]
            m, s = _posterior(ll, center, sd)
            out[key] = {"rho": round(m, 3), "sd": round(s, 3), "pairs": n, "both_hit": both}
            parent_of[key] = center
    return out


def _rho(b: dict, leaf: str, parent: str, root: str) -> float:
    for k in (leaf, parent, root):
        if k in b:
            return b[k]["rho"]
    return 0.0


def _logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def run(oos: dict[str, pd.DataFrame], seed: int = 7, log=print) -> dict:
    ev = events(oos)
    rng = np.random.default_rng(seed)
    z = rng.standard_normal((4000, 3))
    months = sorted(ev.month.unique())
    acc_by_month, rows = {}, []
    total: dict = defaultdict(lambda: [np.zeros(len(GRID)), 0, 0])
    for i, m in enumerate(months):
        em = ev[ev.month == m]
        P = month_pairs(em, rng)
        if P.empty:
            continue
        if i >= MIN_TRAIN_MONTHS:
            buckets = estimate({k: tuple(v) for k, v in total.items()})
            rho = np.array([_rho(buckets, a, b, c) for a, b, c in zip(P.leaf, P.parent, P.root)])
            rows.append(pd.DataFrame({"month": m, "season": int(em.season.iloc[0]), "legs": 2, "rel": P.rel,
                                      "y": (P.ya & P.yb).astype(int), "p_ind": P.pa * P.pb,
                                      "p_cop": p_both(P.pa.to_numpy(), P.pb.to_numpy(), rho)}))
            groups = [g for _, g in em.groupby("game_id") if len(g) >= 3]
            trip = []
            for _ in range(TRIPLES_PER_MONTH if groups else 0):
                g = groups[rng.integers(len(groups))]
                r = g.iloc[rng.choice(len(g), 3, replace=False)]
                R = np.eye(3)
                for a in range(3):
                    for b in range(a + 1, 3):
                        ra, rb = r.iloc[a], r.iloc[b]
                        rel = "player" if ra.player_id == rb.player_id else ("team" if ra.team == rb.team else "opp")
                        R[a, b] = R[b, a] = _rho(buckets, *keys_for(rel, ra.market, ra.position, rb.market, rb.position))
                trip.append((int(r.y.all()), float(np.prod(r.p)), _sim_joint(r.p.to_numpy(), R, z)))
            if trip:
                t = np.array(trip)
                rows.append(pd.DataFrame({"month": m, "season": int(em.season.iloc[0]), "legs": 3, "rel": "mixed",
                                          "y": t[:, 0].astype(int), "p_ind": t[:, 1], "p_cop": t[:, 2]}))
        for k, (ll, n, both) in bucket_ll(P).items():
            total[k][0] = total[k][0] + ll
            total[k][1] += n
            total[k][2] += both
        acc_by_month[m] = len(P)
    V = pd.concat(rows, ignore_index=True)
    rep = evaluate(V, int(ev.season.max()))
    buckets = estimate({k: tuple(v) for k, v in total.items()})
    log(f"nba correlation: {len(ev):,} events, {sum(acc_by_month.values()):,} pairs; pairs gain {rep['pairs']['log_loss_gain']:.5f} "
        f"CI {rep['pairs']['gain_ci']}, used={rep['gate']['passed']}")
    return {"events": int(len(ev)), "pairs": int(sum(acc_by_month.values())), "use_correlation": rep["gate"]["passed"],
            "method": "Gaussian copula; rho by maximum likelihood on walk-forward pairs, shrunk leaf -> parent -> root -> 0",
            "validation": rep, "buckets": buckets}


def _summary(V: pd.DataFrame, reps=500, seed=11) -> dict:
    V = V.assign(ll_ind=_logloss(V.y, V.p_ind), ll_cop=_logloss(V.y, V.p_cop))
    g = V.groupby("month")[["ll_ind", "ll_cop"]].agg(["sum", "count"])
    gain = (g[("ll_ind", "sum")] - g[("ll_cop", "sum")]).to_numpy()
    cnt = g[("ll_ind", "count")].to_numpy()
    rng = np.random.default_rng(seed)
    boots = [gain[i].sum() / cnt[i].sum() for i in (rng.integers(len(gain), size=len(gain)) for _ in range(reps))]
    lo, hi = np.percentile(boots, [2.5, 97.5]) if len(gain) else (0.0, 0.0)
    return {"n": int(len(V)), "months": int(len(gain)), "both_hit_rate": float(V.y.mean()) if len(V) else None,
            "independent": {"log_loss": float(V.ll_ind.mean()), "mean_p": float(V.p_ind.mean())} if len(V) else None,
            "correlated": {"log_loss": float(V.ll_cop.mean()), "mean_p": float(V.p_cop.mean())} if len(V) else None,
            "log_loss_gain": float(V.ll_ind.mean() - V.ll_cop.mean()) if len(V) else 0.0, "gain_ci": [float(lo), float(hi)]}


def evaluate(V: pd.DataFrame, latest_season: int) -> dict:
    pairs_by_season = V[V.legs == 2].season.value_counts()
    full = pairs_by_season[pairs_by_season >= 20000]
    latest_season = int(full.index.max()) if len(full) else latest_season
    last = V[(V.legs == 2) & (V.season == latest_season)]
    out = {"pairs": _summary(V[V.legs == 2]), "triples": _summary(V[V.legs == 3]),
           "by_relation": {r: _summary(V[(V.legs == 2) & (V.rel == r)]) for r in ("player", "team", "opp")},
           "latest_season": latest_season, "latest_season_pairs": _summary(last)}
    checks = [
        {"check": "Same-game pairs: correlated beats independent on log loss (month-bootstrap 95% CI above 0)",
         "value": out["pairs"]["gain_ci"], "pass": out["pairs"]["gain_ci"][0] > 0},
        {"check": "Same-game triples: correlated not worse than independent", "value": out["triples"]["log_loss_gain"],
         "pass": out["triples"]["log_loss_gain"] >= 0},
        {"check": f"{latest_season - 1}-{str(latest_season)[2:]} pairs: correlated not worse than independent",
         "value": out["latest_season_pairs"]["log_loss_gain"], "pass": out["latest_season_pairs"]["log_loss_gain"] >= 0},
        {"check": "At least 10 test months", "value": out["pairs"]["months"], "pass": out["pairs"]["months"] >= 10},
    ]
    out["gate"] = {"checks": checks, "passed": all(c["pass"] for c in checks)}
    return out
