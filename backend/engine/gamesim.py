"""Game simulation: every game played out thousands of times, player by player.

  python -m engine.gamesim            # walk-forward test against the promoted prop models, writes data/results/gamesim.json

Each run of a game draws a final margin from the betting spread, then the team's pass and run volume from its own
recent volume, the opponent, and that game script (teams that fall behind throw more and run less). Targets and
carries are shared out by each player's recent share (with week-to-week wobble), catches and yards come from his own
recent efficiency adjusted for what the defense allows to his position, and the quarterback's line is the sum of
what his receivers did, so every player in a run lives in the same game. Touchdowns follow the team's implied points.

The inputs are the same pregame features the prop models use (engine/props.build_frame: last 8 games, current season
weighted over last season, defenses vs league average from earlier weeks only). The simulation is only used on the
site if, on weeks it never saw, blending it with the promoted model beats the model alone (see blend_test).
"""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd

from . import db, paths, props
from .util import utcnow

N_SIMS = 5000
MARGIN_SD = 13.5          # NFL final margin vs the closing spread
LEAGUE = {"catch_rate": 0.65, "ypr": 10.8, "ypc": 4.3, "int_rate": 0.023, "td_rate": 0.045}
# Tuned on 2021 only (see tune()); evaluation uses 2022 onward.
# On 2021, letting the spread push pass/run volume made the simulation less accurate (team volume already reflects how
# each team plays), so the game-script slopes are 0; the shared volume wobble and share wobble carry the correlation.
PARAMS = {"alpha_tgt": 12.0, "alpha_car": 10.0, "k_rec": 0.6, "k_rush": 0.5, "vol_sd": 0.2, "pass_slope": 0.0, "rush_slope": 0.0,
          "script_sd": 0.0}

SIM_MARKETS = ["pass_yards", "pass_attempts", "completions", "pass_tds", "interceptions", "rush_yards", "carries",
               "rec_yards", "receptions", "rush_rec_yards"]


def _num(x, default=0.0) -> np.ndarray:
    a = np.asarray(pd.to_numeric(pd.Series(x), errors="coerce"), dtype=float)
    return np.where(np.isfinite(a), a, default)


def _dirichlet_multinomial(rng, n: np.ndarray, shares: np.ndarray, alpha: float) -> np.ndarray:
    """n: (S,) totals; shares: (P,) expected shares summing to 1 -> (S, P) counts with game-to-game share wobble."""
    p = rng.gamma(np.maximum(shares * alpha, 1e-3), 1.0, size=(len(n), len(shares)))
    p /= p.sum(axis=1, keepdims=True)
    return rng.multinomial(n.astype(np.int64), p)


def simulate_team(rows: pd.DataFrame, rng, n: int = N_SIMS, params: dict | None = None) -> dict[str, dict[str, np.ndarray]]:
    """Simulate one team's game n times. rows: that team's players for the week (props.build_frame columns).
    Returns {player_id: {stat: (n,) samples}}."""
    P = {**PARAMS, **(params or {})}
    r0 = rows.iloc[0]
    # Game script: the expected margin moves pass/run volume; how far the game actually strays from it (script_sd)
    # is tuned, since a fully random margin adds more noise than it explains.
    exp_margin = float(r0.get("spread_for") or 0.0)
    margin = exp_margin + P["script_sd"] * rng.standard_normal(n)
    vol = np.exp(P["vol_sd"] * rng.standard_normal(n))
    pos = rows.position.to_numpy()

    def pos_mult(col, p):
        sel = rows[rows.position == p][col] if col in rows else pd.Series(dtype=float)
        v = pd.to_numeric(sel, errors="coerce").dropna()
        return float(v.mean()) if len(v) else 1.0

    team_att = float(r0.get("team_attempts_pg") or 33.0) * pos_mult("opp_attempts_mult", "QB")
    team_car = float(r0.get("team_carries_pg") or 26.0) * pos_mult("opp_carries_mult", "RB")
    team_tgt_ratio = float(r0.get("team_targets_pg") or 31.0) / max(float(r0.get("team_attempts_pg") or 33.0), 1.0)
    att = rng.poisson(np.maximum(team_att * vol * np.exp(P["pass_slope"] * margin / 14.0), 1.0))
    car = rng.poisson(np.maximum(team_car * vol * np.exp(P["rush_slope"] * margin / 14.0), 1.0))
    implied = float(r0.get("team_implied_total") or 22.0)
    out: dict[str, dict[str, np.ndarray]] = {}

    # Receivers: targets shared out, then catches and yards from each player's efficiency vs this defense.
    rec_idx = np.where(np.isin(pos, ["RB", "WR", "TE"]))[0]
    tgt_share = _num(rows.targets_share.iloc[rec_idx]) * _num(rows.opp_targets_mult.iloc[rec_idx], 1.0)
    other = max(0.06, 1.0 - tgt_share.sum())
    shares = np.append(tgt_share, other)
    shares /= shares.sum()
    tgts = _dirichlet_multinomial(rng, np.round(att * team_tgt_ratio), shares, P["alpha_tgt"])
    tot_rec = np.zeros(n)
    tot_yds = np.zeros(n)
    for j, i in enumerate(list(rec_idx) + [None]):
        t = tgts[:, j]
        if i is None:
            cr, ypr = LEAGUE["catch_rate"], LEAGUE["ypr"]
        else:
            r = rows.iloc[i]
            m_rec = _num([r.get("opp_receptions_mult")], 1.0)[0] / max(_num([r.get("opp_targets_mult")], 1.0)[0], 0.5)
            cr = float(np.clip(_num([r.get("catch_rate")], LEAGUE["catch_rate"])[0] * m_rec, 0.2, 0.95))
            base_ypr = _num([r.get("ypt")], 7.5)[0] / max(_num([r.get("catch_rate")], LEAGUE["catch_rate"])[0], 0.2)
            m_yds = _num([r.get("opp_rec_yards_mult")], 1.0)[0] / max(_num([r.get("opp_receptions_mult")], 1.0)[0], 0.5)
            ypr = max(base_ypr * m_yds, 2.0)
        rec = rng.binomial(t, cr)
        yds = np.where(rec > 0, rng.gamma(np.maximum(rec, 1) * P["k_rec"], ypr / P["k_rec"]), 0.0)
        tot_rec += rec
        tot_yds += yds
        if i is not None:
            out[rows.iloc[i].player_id] = {"targets": t.astype(float), "receptions": rec.astype(float), "rec_yards": yds}

    # Rushers: carries shared out among the backs and quarterback.
    rush_idx = np.where(np.isin(pos, ["QB", "RB"]))[0]
    car_share = _num(rows.carries_share.iloc[rush_idx]) * _num(rows.opp_carries_mult.iloc[rush_idx], 1.0)
    other = max(0.04, 1.0 - car_share.sum())
    shares = np.append(car_share, other)
    shares /= shares.sum()
    cars = _dirichlet_multinomial(rng, car, shares, P["alpha_car"])
    for j, i in enumerate(rush_idx):
        r = rows.iloc[i]
        ypc = max(_num([r.get("ypc")], LEAGUE["ypc"])[0] * _num([r.get("opp_rush_yards_mult")], 1.0)[0]
                  / max(_num([r.get("opp_carries_mult")], 1.0)[0], 0.5), 1.0)
        c_ = cars[:, j]
        yds = np.where(c_ > 0, rng.gamma(np.maximum(c_, 1) * P["k_rush"], ypc / P["k_rush"]), 0.0)
        d = out.setdefault(r.player_id, {})
        d["carries"], d["rush_yards"] = c_.astype(float), yds

    # Passer: the quarterback with the most attempts per game throws them all; his line is his receivers' total.
    qbs = rows[rows.position == "QB"]
    if len(qbs):
        q = qbs.iloc[int(np.argmax(_num(qbs.attempts_pg)))]
        att_pg = max(_num([q.get("attempts_pg")], 30.0)[0], 10.0)
        int_rate = (_num([q.get("interceptions_pg")], 0.0)[0] * 8 + LEAGUE["int_rate"] * att_pg * 4) / (att_pg * 12)
        td_rate = (_num([q.get("pass_tds_pg")], 0.0)[0] * 8 + LEAGUE["td_rate"] * att_pg * 4) / (att_pg * 12)
        ints = rng.poisson(att * int_rate * _num([q.get("opp_interceptions_mult")], 1.0)[0])
        tds = rng.poisson(att * td_rate * _num([q.get("opp_pass_tds_mult")], 1.0)[0] * (implied / 22.5) ** 0.8
                          * np.exp(0.04 * margin / 14.0))
        d = out.setdefault(q.player_id, {})
        d |= {"attempts": att.astype(float), "completions": tot_rec, "pass_yards": tot_yds, "pass_tds": tds.astype(float),
              "interceptions": ints.astype(float)}
    for d in out.values():
        if "rec_yards" in d or "rush_yards" in d:
            d["rush_rec_yards"] = d.get("rec_yards", 0.0) + d.get("rush_yards", 0.0)
    return out


def simulate_week(week_rows: pd.DataFrame, n: int = N_SIMS, seed: int = 7, params: dict | None = None) -> dict[tuple, dict]:
    """{(player_id, team): {stat: samples}} for every team in the frame rows of one week."""
    rng = np.random.default_rng(seed)
    res = {}
    for team, rows in week_rows.groupby("team"):
        rows = rows[rows.has_history.eq(1)]
        if rows.empty:
            continue
        for pid, d in simulate_team(rows.reset_index(drop=True), rng, n, params).items():
            res[(pid, team)] = d
    return res


def _logit(p):
    p = np.clip(np.asarray(p, float), 0.005, 0.995)  # same clip as the site's pOver
    return np.log(p / (1 - p))


def blend_p(model_p: float, sim: dict, line: float) -> float:
    """Blended chance of the over (same rule as frontend pOver with dist.sim)."""
    q = np.asarray(sim["q"], float)
    p_sim = float(np.clip((q > line).mean(), 0.005, 0.995))
    w = sim["w"]
    z = w[0] * _logit(model_p) + w[1] * _logit(p_sim) + w[2]
    return float(np.clip(1 / (1 + np.exp(-z)), 0.005, 0.995))


def fit_weights(D: pd.DataFrame) -> list[float]:
    from sklearn.linear_model import LogisticRegression  # noqa: PLC0415
    fit = LogisticRegression(C=1.0).fit(np.c_[_logit(D.p_over), _logit(D.p_sim)], D.y)
    return [float(fit.coef_[0][0]), float(fit.coef_[0][1]), float(fit.intercept_[0])]


def _ll(y, p):
    p = np.clip(p, 1e-3, 1 - 1e-3)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def sim_over(frame: pd.DataFrame, bt: pd.DataFrame, weeks, n=N_SIMS, params=None) -> pd.DataFrame:
    """Simulated chance of the over at each backtest row's reference line, one week at a time, pregame features only."""
    lab = frame[frame.labelled == 1]
    out = []
    for s, w in weeks:
        rows = lab[(lab.season == s) & (lab.week == w)]
        sims = simulate_week(rows, n, seed=s * 100 + w, params=params)
        b = bt[(bt.season == s) & (bt.week == w)].copy()
        p = np.full(len(b), np.nan)
        for k, r in enumerate(b.itertuples(index=False)):
            d = sims.get((r.player_id, r.team))
            st = props.MARKETS[r.market]["stat"]
            if d is not None and st in d:
                p[k] = float((d[st] > r.line).mean())
        b["p_sim"] = p
        out.append(b)
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def _backtest_rows(c) -> pd.DataFrame:
    rep = props.latest_report(c)
    parts = []
    for market, r in rep["markets"].items():
        model = r["gate"]["promoted"]
        if model:
            parts.append(pd.read_sql_query("SELECT ? AS market, season, week, player_id, team, line, p_over, actual FROM prop_backtest "
                                           "WHERE run_id=? AND market=? AND model=? AND actual IS NOT NULL", c,
                                           params=(market, rep["run_id"], market, model)))
    bt = pd.concat(parts, ignore_index=True)
    bt["y"] = (bt.actual > bt.line).astype(int)
    return bt


def blend_test(D: pd.DataFrame, first_eval: int = 2022) -> dict:
    """Walk-forward stacking per market: logistic on logit(model) and logit(sim), fit on earlier weeks only."""
    from sklearn.linear_model import LogisticRegression  # noqa: PLC0415
    lg = _logit
    D = D.dropna(subset=["p_sim"]).sort_values(["season", "week"]).reset_index(drop=True)
    res = {}
    for market, g in D.groupby("market"):
        g = g.reset_index(drop=True)
        g["p_blend"] = np.nan
        weeks = g[["season", "week"]].drop_duplicates().values.tolist()
        for s, w in weeks:
            if s < first_eval:
                continue
            tr = g[(g.season < s) | ((g.season == s) & (g.week < w))]
            te = (g.season == s) & (g.week == w)
            if len(tr) < 500:
                continue
            X = np.c_[lg(tr.p_over), lg(tr.p_sim)]
            fit = LogisticRegression(C=1.0).fit(X, tr.y)
            g.loc[te, "p_blend"] = fit.predict_proba(np.c_[lg(g.loc[te, "p_over"]), lg(g.loc[te, "p_sim"])])[:, 1]
            coef = fit.coef_[0].tolist()
        e = g.dropna(subset=["p_blend"])
        if e.empty:
            continue
        ll_m, ll_s, ll_b = _ll(e.y, e.p_over).mean(), _ll(e.y, e.p_sim).mean(), _ll(e.y, e.p_blend).mean()
        # Paired bootstrap by week for the blend's gain over the model alone.
        wk = e.groupby(["season", "week"]).apply(lambda x: (_ll(x.y, x.p_over) - _ll(x.y, x.p_blend)).sum() / 1.0).to_numpy()
        nwk = e.groupby(["season", "week"]).size().to_numpy()
        rng = np.random.default_rng(1)
        boots = []
        for _ in range(300):
            i = rng.integers(0, len(wk), len(wk))
            boots.append(wk[i].sum() / nwk[i].sum())
        lo, hi = np.percentile(boots, [5, 95])

        def hits(p):  # the side each source favors, among picks it rates 65%+
            side = np.maximum(p, 1 - p)
            m = side >= 0.65
            hit = np.where(p >= 0.5, e.y, 1 - e.y)
            return {"n": int(m.sum()), "rate": float(hit[m].mean()) if m.any() else None}
        res[market] = {"n": int(len(e)), "weeks": int(e[["season", "week"]].drop_duplicates().shape[0]),
                       "log_loss_model": float(ll_m), "log_loss_sim": float(ll_s), "log_loss_blend": float(ll_b),
                       "gain": float(ll_m - ll_b), "gain_ci90": [float(lo), float(hi)], "adopt": bool(lo > 0),
                       "last_weights": coef, "strong_model": hits(e.p_over.to_numpy()), "strong_sim": hits(e.p_sim.to_numpy()),
                       "strong_blend": hits(e.p_blend.to_numpy())}
    return res


def run(c, frame: pd.DataFrame | None = None, log=print, n: int = 2000) -> dict:
    """Walk-forward test of the simulation on every backtest week, then the blend weights for markets where it helped.
    Rerun each update, so the weights keep learning from every newly finished week."""
    frame = props.build_frame(c) if frame is None else frame
    bt = _backtest_rows(c)
    weeks = bt[["season", "week"]].drop_duplicates().sort_values(["season", "week"]).values.tolist()
    log(f"gamesim: simulating {len(weeks)} past weeks, {n} runs per game")
    D = sim_over(frame, bt, weeks, n=n).dropna(subset=["p_sim"])
    rep = {"created_at": utcnow(), "sims_per_game": n, "params": PARAMS, "markets": blend_test(D)}
    for m, r in rep["markets"].items():
        if r["adopt"]:
            r["weights"] = fit_weights(D[D.market == m])
    for m, r in rep["markets"].items():
        log(f"gamesim {m}: model {r['log_loss_model']:.4f} sim {r['log_loss_sim']:.4f} blend {r['log_loss_blend']:.4f} "
            f"gain {r['gain']:+.4f} ci90 [{r['gain_ci90'][0]:+.4f},{r['gain_ci90'][1]:+.4f}] adopt={r['adopt']}")
    paths.results_dir().mkdir(parents=True, exist_ok=True)
    (paths.results_dir() / "gamesim.json").write_text(json.dumps(rep, indent=2, default=float))
    return rep


def latest() -> dict | None:
    f = paths.results_dir() / "gamesim.json"
    return json.loads(f.read_text()) if f.exists() else None


def attach(c, frame: pd.DataFrame, season: int, week: int, run_id: str, log=print, n: int = N_SIMS) -> dict:
    """Simulate the upcoming week and add the simulation to each projection in a market where the blend was adopted."""
    rep = latest()
    adopted = {m: r["weights"] for m, r in (rep or {}).get("markets", {}).items() if r.get("adopt") and r.get("weights")}
    rows = frame[(frame.season == season) & (frame.week == week)]
    sims = simulate_week(rows, n, seed=season * 100 + week)
    qs = np.arange(1, 100)
    updates, count = [], {}
    for r in c.execute("SELECT market, player_id, team, dist FROM prop_projections WHERE run_id=? AND calibrated=1", (run_id,)).fetchall():
        d = sims.get((r["player_id"], r["team"]))
        st = props.MARKETS[r["market"]]["stat"]
        if r["market"] not in adopted or d is None or st not in d or not r["dist"]:
            continue
        dist = json.loads(r["dist"])
        dist["sim"] = {"q": [round(float(x), 2) for x in np.percentile(d[st], qs)], "w": adopted[r["market"]],
                       "median": float(np.median(d[st])), "runs": n}
        updates.append((json.dumps(dist), run_id, r["market"], r["player_id"]))
        count[r["market"]] = count.get(r["market"], 0) + 1
    with c:
        c.executemany("UPDATE prop_projections SET dist=? WHERE run_id=? AND market=? AND player_id=?", updates)
    log(f"gamesim: {n} runs per game for {season} W{week}; blended into " + (", ".join(f"{k} {v}" for k, v in count.items()) or "no markets"))
    return count


if __name__ == "__main__":
    run(db.connect(paths.db_path()))
