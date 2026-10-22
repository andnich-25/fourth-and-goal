"""Backtest reports for college football: how each market's picks did on games the model never saw.

Every game from BACKTEST_FIRST on is played 5,000 times with the model as it stood before that week (model.py), the
lean in each market is graded at the closing line, and leans are grouped into tiers by their chance. A tier is
"proven" only if it beat the break-even rate for a standard -110 price (52.4%) over the whole test AND did not lose
(50%+) over the last two seasons on their own AND every stronger tier is proven too. Moneylines are graded by return
on a flat stake instead, since a 70% favorite winning 70% of the time makes nothing: proven means 2+ cents per dollar
over the whole test and a profit over the last two seasons.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import history, model

BACKTEST_FIRST = 2016
TIERS = [("Coin flip", 0.50, 0.52), ("Lean", 0.52, 0.54), ("Strong", 0.54, 1.0)]
ML_TIERS = [("Thin", 0.0, 0.04), ("Value", 0.04, 10.0)]
ML_PRICE_RANGE = (-400, 300)   # longer shots are lottery tickets: a handful of upsets swing the whole record
BREAK_EVEN = 110 / 210
ML_MIN_ROI = 0.02   # a moneyline tier must have returned 2+ cents per dollar; less is inside the noise of upsets
MARKETS = {"spread": "Spread", "total": "Game total", "team_total": "Team total", "moneyline": "Moneyline"}


def _wilson(k: int, n: int, z: float = 1.96) -> list:
    if not n:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [float(c - h), float(c + h)]


def simulate_backtest(oos: pd.DataFrame, first: int = BACKTEST_FIRST) -> pd.DataFrame:
    """Chances for every finished game from `first` on, each week simulated with misses from earlier weeks only."""
    rows = []
    test = oos[oos.season >= first]
    for i, (_, grp) in enumerate(test.groupby(model.week_key(test), sort=True)):
        pool = model.miss_pool(oos, grp.date.min() - pd.Timedelta(hours=6))
        h, a = model.simulate(grp.pred_home.to_numpy(), grp.pred_away.to_numpy(), pool, seed=i)
        tth = model.implied_team_total(grp.spread, grp.total, "home")
        tta = model.implied_team_total(grp.spread, grp.total, "away")
        c = model.chances(h, a, grp.spread.to_numpy(), grp.total.to_numpy(), tth.to_numpy(), tta.to_numpy())
        rows.append(grp.assign(**{k: v for k, v in c.items() if np.ndim(v) == 1}, tt_home=tth, tt_away=tta))
    return pd.concat(rows) if rows else pd.DataFrame()


def graded(bt: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """One row per lean: chance of the side picked, won or lost (pushes dropped), season."""
    def lean(p, diff, extra=None):
        side = np.where(p >= 0.5, 1, -1)
        res = np.sign(diff)
        d = pd.DataFrame({"p": np.maximum(p, 1 - p), "won": (side == res).astype(int), "push": res == 0,
                          "season": bt.season.to_numpy(), "side": np.where(side > 0, "a", "b")}, index=bt.index)
        if extra is not None:
            d = d.assign(**extra)
        return d[~d.push]
    out = {
        "spread": lean(bt.p_home_cover.to_numpy(), (bt.margin + bt.spread).to_numpy(),
                       {"fav_side": np.where((bt.p_home_cover >= 0.5) == (bt.spread < 0), "favorite", "underdog")}),
        "total": lean(bt.p_over.to_numpy(), (bt.pts - bt.total).to_numpy()),
    }
    out["total"]["side"] = np.where(out["total"].side == "a", "over", "under")
    tt = pd.concat([lean(bt.p_home_tt_over.to_numpy(), (bt.home_points - bt.tt_home).to_numpy()),
                    lean(bt.p_away_tt_over.to_numpy(), (bt.away_points - bt.tt_away).to_numpy())], ignore_index=True)
    tt["side"] = np.where(tt.side == "a", "over", "under")
    out["team_total"] = tt
    return out


def moneyline_bets(bt: pd.DataFrame) -> pd.DataFrame:
    """The side with the better expected return at the closing moneyline, inside ML_PRICE_RANGE."""
    m = bt[bt.ml_home.notna() & bt.ml_away.notna() & (bt.margin != 0)]
    dh, da = history.decimal(m.ml_home.to_numpy()), history.decimal(m.ml_away.to_numpy())
    evh, eva = m.p_home_win * dh - 1, (1 - m.p_home_win) * da - 1
    home = evh >= eva
    price = np.where(home, m.ml_home, m.ml_away)
    dec = np.where(home, dh, da)
    won = np.where(home, m.margin > 0, m.margin < 0).astype(int)
    r = pd.DataFrame({"ev": np.maximum(evh, eva), "price": price, "won": won, "ret": won * dec - 1,
                      "p": np.where(home, m.p_home_win, 1 - m.p_home_win), "season": m.season.to_numpy()}, index=m.index)
    return r[(r.price >= ML_PRICE_RANGE[0]) & (r.price <= ML_PRICE_RANGE[1]) & (r.ev > 0)]


def tier_rows(d: pd.DataFrame, tiers=TIERS, recent: list[int] | None = None) -> list[dict]:
    out = []
    for name, lo, hi in tiers:
        t = d[(d.p >= lo) & (d.p < hi)]
        n, k = len(t), int(t.won.sum())
        r = t[t.season.isin(recent or [])]
        rate = k / n if n else None
        recent_rate = float(r.won.mean()) if len(r) else None
        proven = bool(n >= 100 and rate is not None and rate >= BREAK_EVEN and recent_rate is not None and recent_rate >= 0.5)
        out.append({"tier": name, "lo": lo, "hi": hi, "n": n, "hits": k, "rate": rate, "ci": _wilson(k, n),
                    "avg_chance": float(t.p.mean()) if n else None, "recent_n": int(len(r)), "recent_rate": recent_rate,
                    "proven": proven})
    return _consistent(out)


def _consistent(tiers: list[dict]) -> list[dict]:
    """A tier counts only if every stronger tier counts too: when a higher-confidence group did worse, the lower one's
    result is more likely luck than skill."""
    ok = True
    for t in reversed(tiers):
        ok = ok and t["proven"]
        t["proven"] = ok
    return tiers


def ml_tier_rows(d: pd.DataFrame, recent: list[int]) -> list[dict]:
    out = []
    for name, lo, hi in ML_TIERS:
        t = d[(d.ev >= lo) & (d.ev < hi)]
        r = t[t.season.isin(recent)]
        roi = float(t.ret.mean()) if len(t) else None
        rroi = float(r.ret.mean()) if len(r) else None
        out.append({"tier": name, "lo": lo, "hi": hi, "n": int(len(t)), "hits": int(t.won.sum()),
                    "rate": float(t.won.mean()) if len(t) else None, "roi": roi, "recent_n": int(len(r)), "recent_roi": rroi,
                    "avg_price": float(np.median(t.price)) if len(t) else None,
                    "proven": bool(len(t) >= 300 and roi is not None and roi >= ML_MIN_ROI and rroi is not None and rroi > 0)})
    return _consistent(out)


def by_season(d: pd.DataFrame, min_p: float) -> list[dict]:
    t = d[d.p >= min_p]
    return [{"season": int(s), "n": int(len(x)), "rate": float(x.won.mean())} for s, x in t.groupby("season")]


def summarize(bt: pd.DataFrame) -> dict:
    seasons = sorted(int(s) for s in bt.season.unique())
    full = [s for s in seasons if (bt.season == s).sum() >= 300]
    recent = full[-2:]
    g = graded(bt)
    out = {"first_season": seasons[0], "last_season": seasons[-1], "games": int(len(bt)), "recent_seasons": recent,
           "break_even": BREAK_EVEN, "markets": {}}
    for m, d in g.items():
        tiers = tier_rows(d, recent=recent)
        sides = {s: tier_rows(x, recent=recent) for s, x in d.groupby("side")} if m != "spread" else \
            {s: tier_rows(x, recent=recent) for s, x in d.groupby("fav_side")}
        if m == "spread":
            sides = {k: v for k, v in sides.items()}
        out["markets"][m] = {"label": MARKETS[m], "tiers": tiers, "by_side": sides, "n": int(len(d)),
                             "rate": float(d.won.mean()), "by_season": by_season(d, 0.54),
                             "line": "implied" if m == "team_total" else "closing",
                             "proven": any(t["proven"] for t in tiers)}
    ml = moneyline_bets(bt)
    tiers = ml_tier_rows(ml, recent)
    out["markets"]["moneyline"] = {"label": MARKETS["moneyline"], "tiers": tiers, "n": int(len(ml)),
                                   "roi": float(ml.ret.mean()) if len(ml) else None,
                                   "by_season": [{"season": int(s), "n": int(len(x)), "roi": float(x.ret.mean())}
                                                 for s, x in ml.groupby("season")],
                                   "price_range": list(ML_PRICE_RANGE), "line": "closing",
                                   "proven": any(t["proven"] for t in tiers)}
    # calibration: chance vs what happened, in tenths, for the two lines that matter most
    out["calibration"] = {}
    for name, p, y in (("cover", bt.p_home_cover, bt.margin + bt.spread > 0), ("over", bt.p_over, bt.pts > bt.total),
                       ("win", bt.p_home_win, bt.margin > 0)):
        q = pd.qcut(p, 10, duplicates="drop")
        c = pd.DataFrame({"p": p, "y": y.astype(float)}).groupby(q, observed=True).mean()
        out["calibration"][name] = [{"p": float(a), "actual": float(b)} for a, b in zip(c.p, c.y)]
    return out


def opening_totals(oos: pd.DataFrame, bt: pd.DataFrame) -> dict | None:
    """Same total leans graded against the opening total instead of the close (books' first number of the week)."""
    b = bt[bt.total_open.notna()] if "total_open" in bt else pd.DataFrame()
    if b.empty:
        return None
    pool_rows = []
    for i, (_, grp) in enumerate(b.groupby(model.week_key(b), sort=True)):
        pool = model.miss_pool(oos, grp.date.min() - pd.Timedelta(hours=6))
        h, a = model.simulate(grp.pred_home.to_numpy(), grp.pred_away.to_numpy(), pool, seed=1000 + i)
        line = grp.total_open.to_numpy(float)[:, None]
        tot = h + a
        win, loss = (tot > line).mean(1), (tot < line).mean(1)
        pool_rows.append(pd.DataFrame({"p_over": win / np.maximum(win + loss, 1e-9), "diff": grp.pts - grp.total_open,
                                       "season": grp.season}, index=grp.index))
    r = pd.concat(pool_rows)
    side = np.where(r.p_over >= 0.5, 1, -1)
    res = np.sign(r["diff"])
    d = pd.DataFrame({"p": np.maximum(r.p_over, 1 - r.p_over), "won": (side == res).astype(int), "season": r.season})[res != 0]
    seasons = sorted(int(s) for s in d.season.unique())
    return {"n": int(len(d)), "tiers": tier_rows(d, recent=seasons[-2:]), "by_season": by_season(d, 0.54)}


# --------------------------------------------------------------------------- research findings
def findings(g: pd.DataFrame) -> list[dict]:
    """Plain patterns in closing lines, each measured in two separate eras (2014-2021 and 2022 on) so a pattern that
    only showed up once is easy to spot. Rate = how often the named side won against the closing number."""
    d = g[g.final & g.spread.notna() & g.total.notna() & (g.season >= 2014)].copy()
    d["absp"] = d.spread.abs()
    fav_home = d.spread < 0
    dog_cov = np.where(fav_home, -np.sign(d.margin + d.spread), np.sign(d.margin + d.spread))
    under = -np.sign(d.pts - d.total)
    over = -under
    era = np.where(d.season <= 2021, "2014-21", "2022-26")
    month = d.date.dt.month
    rules = [
        ("spread", "Underdogs of 3.5 points or less", (d.absp > 0) & (d.absp <= 3.5), dog_cov, "underdog covers"),
        ("spread", "Underdogs of 4 to 7.5", (d.absp > 3.5) & (d.absp <= 7.5), dog_cov, "underdog covers"),
        ("spread", "Underdogs of 8 to 14.5", (d.absp > 7.5) & (d.absp <= 14.5), dog_cov, "underdog covers"),
        ("spread", "Underdogs of 15 to 21.5", (d.absp > 14.5) & (d.absp <= 21.5), dog_cov, "underdog covers"),
        ("spread", "Underdogs of 22 or more", d.absp > 21.5, dog_cov, "underdog covers"),
        ("spread", "Home underdogs", ~fav_home & (d.absp > 0) & ~d.neutral, dog_cov, "underdog covers"),
        ("spread", "Road underdogs", fav_home & ~d.neutral, dog_cov, "underdog covers"),
        ("spread", "Conference games, underdog", d.conference_game & (d.absp > 0), dog_cov, "underdog covers"),
        ("total", "Totals of 45 or less", d.total <= 45, under, "under"),
        ("total", "Totals of 45.5 to 55", (d.total > 45) & (d.total <= 55), under, "under"),
        ("total", "Totals of 55.5 to 60", (d.total > 55) & (d.total <= 60), under, "under"),
        ("total", "Totals over 60", d.total > 60, under, "under"),
        ("total", "Totals of 65 or more", d.total >= 65, under, "under"),
        ("total", "Neutral-site games", d.neutral, under, "under"),
        ("total", "November and later, total 55+", (month >= 11) & (d.total >= 55), under, "under"),
        ("total", "Spread of 21 or more (blowouts)", d.absp >= 21, over, "over"),
        ("total", "Spread of 3 or less (close games)", d.absp <= 3, under, "under"),
        ("total", "Army, Navy or Air Force playing", d.home_team.isin(["Army", "Navy", "Air Force"]) |
         d.away_team.isin(["Army", "Navy", "Air Force"]), over, "over"),
    ]
    out = []
    for market, name, mask, res, side in rules:
        row = {"market": market, "pattern": name, "side": side, "eras": []}
        for e in ("2014-21", "2022-26"):
            sel = np.asarray(mask) & (era == e) & (np.asarray(res) != 0)
            n = int(sel.sum())
            row["eras"].append({"era": e, "n": n, "rate": float((np.asarray(res)[sel] > 0).mean()) if n else None})
        rates = [x["rate"] for x in row["eras"] if x["rate"] is not None]
        row["holds"] = bool(len(rates) == 2 and min(rates) >= BREAK_EVEN)
        out.append(row)
    # moneyline prices: what each price band returned on a flat stake
    m = g[g.final & g.ml_home.notna() & g.ml_away.notna() & (g.margin != 0) & (g.season >= 2014)]
    sides = []
    for side, won in (("home", m.margin > 0), ("away", m.margin < 0)):
        pr = m[f"ml_{side}"].to_numpy(float)
        sides.append(pd.DataFrame({"price": pr, "ret": won.to_numpy() * history.decimal(pr) - 1,
                                   "era": np.where(m.season <= 2021, "2014-21", "2022-26")}))
    s = pd.concat(sides)
    bands = [(-100000, -1000, "Favorites -1000 or shorter"), (-999, -400, "Favorites -400 to -999"),
             (-399, -200, "Favorites -200 to -399"), (-199, -101, "Favorites -101 to -199"),
             (100, 150, "Underdogs +100 to +150"), (151, 250, "Underdogs +151 to +250"),
             (251, 600, "Underdogs +251 to +600"), (601, 100000, "Underdogs +601 or longer")]
    for lo, hi, name in bands:
        row = {"market": "moneyline", "pattern": name, "side": "return per $1", "eras": []}
        for e in ("2014-21", "2022-26"):
            t = s[(s.price >= lo) & (s.price <= hi) & (s.era == e)]
            row["eras"].append({"era": e, "n": int(len(t)), "roi": float(t.ret.mean()) if len(t) else None})
        rois = [x["roi"] for x in row["eras"] if x["roi"] is not None]
        row["holds"] = bool(len(rois) == 2 and min(rois) > 0)
        out.append(row)
    return out


def upsets(bt: pd.DataFrame, seed: int = 0) -> dict:
    """How the model does on underdogs: does a dog it gives 35% really win 35% of the time, and how did the
    moneyline value bets (mostly dogs) do season by season, with a bootstrap over weeks for how sure we can be."""
    m = bt[bt.ml_home.notna() & bt.ml_away.notna() & (bt.margin != 0)]
    ih, ia = history.implied(m.ml_home.to_numpy()), history.implied(m.ml_away.to_numpy())
    fair_h = ih / (ih + ia)
    dog_home = fair_h < 0.5
    d = pd.DataFrame({"p": np.where(dog_home, m.p_home_win, 1 - m.p_home_win), "market": np.where(dog_home, fair_h, 1 - fair_h),
                      "won": np.where(dog_home, m.margin > 0, m.margin < 0).astype(int)}, index=m.index)
    bins = []
    for lo, hi in ((0, 0.1), (0.1, 0.2), (0.2, 0.3), (0.3, 0.4), (0.4, 0.5)):
        t = d[(d.p >= lo) & (d.p < hi)]
        if len(t):
            bins.append({"lo": lo, "hi": hi, "n": int(len(t)), "model": float(t.p.mean()), "market": float(t.market.mean()),
                         "actual": float(t.won.mean())})
    ml = moneyline_bets(bt)
    v = ml[ml.ev >= ML_TIERS[1][1]]
    out = {"calibration": bins, "dogs": int(len(d)), "dog_win_rate": float(d.won.mean())}
    if len(v):
        wk = v.season.astype(str) + "-" + bt.loc[v.index, "week"].astype(str)
        gs = v.groupby(wk).ret.agg(["sum", "size"])
        rng = np.random.default_rng(seed)
        boots = []
        for _ in range(2000):
            i = rng.integers(0, len(gs), len(gs))
            boots.append(gs["sum"].to_numpy()[i].sum() / gs["size"].to_numpy()[i].sum())
        bands = []
        for lo, hi, name in ((-400, -101, "Favorites"), (100, 150, "+100 to +150"), (151, 250, "+151 to +250"), (251, 300, "+251 to +300")):
            t = v[(v.price >= lo) & (v.price <= hi)]
            if len(t):
                bands.append({"band": name, "n": int(len(t)), "win": float(t.won.mean()), "roi": float(t.ret.mean())})
        out["value_bets"] = {"n": int(len(v)), "roi": float(v.ret.mean()), "win": float(v.won.mean()),
                             "dog_share": float((v.price > 0).mean()), "p_profit": float((np.array(boots) > 0).mean()),
                             "roi_ci90": [float(x) for x in np.percentile(boots, [5, 95])],
                             "by_season": [{"season": int(s), "n": int(len(x)), "roi": float(x.ret.mean()), "win": float(x.won.mean())}
                                           for s, x in v.groupby("season")],
                             "by_price": bands}
    return out
