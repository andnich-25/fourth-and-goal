"""Walk-forward reports for NBA props: per-market gate against baselines, confidence tiers, and the Due study."""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import props

PROP_MIN_MINUTES = 15   # confidence bands are measured on the players and lines the site picks from
MIN_LINE = 1.5          # an "under 0.5" on a player who rarely records the stat is not a real bet
TIERS = [("Toss-up", 0.50, 0.55), ("Lean", 0.55, 0.60), ("Solid", 0.60, 0.65), ("Strong", 0.65, 1.0)]


def _wilson(k: int, n: int, z: float = 1.96) -> tuple[float | None, float | None]:
    if not n:
        return None, None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return float(c - h), float(c + h)


def _ece(p: np.ndarray, y: np.ndarray, bins: int = 10) -> float:
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    return float(sum(abs(p[idx == b].mean() - y[idx == b].mean()) * (idx == b).mean() for b in range(bins) if (idx == b).any()))


def _brier(p, y):
    return float(np.mean((p - y) ** 2))


def market_report(r: pd.DataFrame, market: str, reps: int = 300, seed: int = 3) -> dict:
    """Model vs the player-average baseline on unseen months: distribution accuracy (CRPS), over/under accuracy at the
    usual line, calibration, and the latest season on its own."""
    rng = np.random.default_rng(seed)
    s = r.sample(frac=1.0, random_state=0)
    s = s[s.groupby("month").cumcount() < 1500].sort_values("month")
    s = s.assign(crps_m=props.crps(s.mu.to_numpy(), s.alpha.to_numpy(), s.y.to_numpy()),
                 crps_b=props.crps(s.base_mu.to_numpy(), s.base_alpha.to_numpy(), s.y.to_numpy()))
    gm = s.groupby("month")[["crps_m", "crps_b"]].sum()
    cnt = s.groupby("month").size().to_numpy()
    gain = (gm.crps_b - gm.crps_m).to_numpy()
    boots = [gain[i].sum() / cnt[i].sum() for i in (rng.integers(len(gain), size=len(gain)) for _ in range(reps))]
    lo, hi = np.percentile(boots, [2.5, 97.5])
    h = r[r.line.notna()]
    y = (h.y > h.line).astype(int).to_numpy()
    po, pb = h.p_over.to_numpy(), h.p_over_base.to_numpy()
    counts = r.season.value_counts()
    latest = int(counts[counts >= 5000].index.max()) if (counts >= 5000).any() else int(r.season.max())  # last full season
    hl = h[h.season == latest]
    yl = (hl.y > hl.line).astype(int).to_numpy()
    lean = np.maximum(po, 1 - po)
    hit = np.where(po >= 0.5, y, 1 - y)
    strong = (lean >= 0.6) & (h.min_l.to_numpy() >= PROP_MIN_MINUTES) & (h.line.to_numpy() >= MIN_LINE)
    crps_m, crps_b = float(s.crps_m.mean()), float(s.crps_b.mean())
    checks = {
        "enough_rows": len(r) >= 5000,
        "enough_weeks": r.month.nunique() >= 10,
        "beats_baselines_crps": crps_m < crps_b,
        "crps_gain_ci_excludes_zero": bool(lo > 0),
        "beats_baselines_over_brier": _brier(po, y) < _brier(pb, y),
        "over_calibrated": _ece(po, y) <= 0.025,
        "latest_season_not_worse": len(hl) == 0 or _brier(hl.p_over.to_numpy(), yl) <= _brier(hl.p_over_base.to_numpy(), yl) + 0.001,
    }
    q10 = (r.y >= _nb_ppf(r, 0.1)).mean()
    q90 = (r.y <= _nb_ppf(r, 0.9)).mean()
    return {
        "market": market, "label": props.MARKETS[market], "validated": all(checks.values()), "tested": True,
        "model": "nba-hgb-1", "checks": checks, "failed_checks": [k for k, v in checks.items() if not v],
        "test_rows": int(len(r)), "test_months": int(r.month.nunique()), "first_season": int(r.season.min()),
        "crps": crps_m, "baseline_crps": crps_b, "crps_gain_pct": float((crps_b - crps_m) / crps_b * 100), "crps_gain_ci": [float(lo), float(hi)],
        "mae": float(np.abs(r.y - r.mu).mean()), "baseline_mae": float(np.abs(r.y - r.base_mu).mean()),
        "over_brier": _brier(po, y), "baseline_over_brier": _brier(pb, y), "coin_brier": _brier(np.full(len(y), y.mean()), y),
        "over_ece": _ece(po, y), "coverage_10_90": float(q10 + q90 - 1), "coverage_expected": 0.8,
        "lean_n": int(strong.sum()), "lean_hit_rate": float(hit[strong].mean()) if strong.any() else None,
        "latest_season": latest,
    }


def _nb_ppf(r: pd.DataFrame, q: float) -> np.ndarray:
    from scipy import stats as st  # noqa: PLC0415
    n, p = props.nb_params(r.mu.to_numpy(), r.alpha.to_numpy())
    return st.nbinom.ppf(q, n, p)


def tier_rows(lean: np.ndarray, hit: np.ndarray) -> list[dict]:
    out = []
    for name, lo, hi in TIERS:
        m = (lean >= lo) & (lean < (hi if hi < 1 else 1.01))
        k, n = int(hit[m].sum()), int(m.sum())
        out.append({"tier": name, "lo": lo, "hi": hi, "n": n, "hits": k, "rate": k / n if n else None,
                    "avg_chance": float(lean[m].mean()) if n else None, "ci": list(_wilson(k, n))})
    return out


def confidence(oos: dict[str, pd.DataFrame], validated: set[str]) -> dict:
    """How often each confidence band hit on unseen games, overall, by side and by market (validated markets only)."""
    parts = []
    for market, r in oos.items():
        if market not in validated:
            continue
        h = r[r.line.notna() & (r.min_l >= PROP_MIN_MINUTES) & (r.line >= MIN_LINE)]
        parts.append(pd.DataFrame({"market": market, "season": h.season, "p": h.p_over, "y": (h.y > h.line).astype(int)}))
    if not parts:
        return {"props": None}
    a = pd.concat(parts)
    lean = np.maximum(a.p, 1 - a.p).to_numpy()
    side = np.where(a.p >= 0.5, "over", "under")
    hit = np.where(side == "over", a.y, 1 - a.y)
    by_market = []
    for market, g in a.assign(lean=lean, hit=hit, side=side).groupby("market"):
        st_ = g[g.lean >= 0.6]
        by_market.append({"market": market, "label": props.MARKETS[market], "n": int(len(g)), "rate": float(g.hit.mean()),
                          "strong_n": int(len(st_)), "strong_rate": float(st_.hit.mean()) if len(st_) else None,
                          "unders_strong_rate": float(st_[st_.side == "under"].hit.mean()) if (st_.side == "under").any() else None,
                          "overs_strong_rate": float(st_[st_.side == "over"].hit.mean()) if (st_.side == "over").any() else None})
    return {"props": {
        "first_season": int(a.season.min()), "months": int(sum(r.month.nunique() for m, r in oos.items() if m in validated) / max(1, len(validated))),
        "tiers": tier_rows(lean, hit),
        "by_side": {s: tier_rows(lean[side == s], hit[side == s]) for s in ("over", "under")},
        "by_market": by_market,
        "note": f"Chance of the side picked, at each player's usual line, on games the model never saw (players averaging {PROP_MIN_MINUTES}+ minutes, lines of {MIN_LINE}+).",
    }}


def due_study(oos: dict[str, pd.DataFrame], min_games: int = 4) -> dict:
    """Due: a player who finished under his projection in each of his last min_games games while his minutes held up.
    Do such players bounce back more than the model expects? Reported, and used only as a label, never added on top."""
    out = {}
    for market, r in oos.items():
        r = r.sort_values(["player_id", "game_date"]).copy()
        below = (r.y < r.mu).astype(int)
        streak = below.groupby(r.player_id).transform(lambda s: s.shift(1).rolling(min_games, min_periods=min_games).sum())
        due = (streak == min_games) & (r.min_l >= 20)
        h = r[due & r.line.notna()]
        rest = r[~due & r.line.notna()]
        if len(h) < 200:
            continue
        out[market] = {"label": props.MARKETS[market], "n": int(len(h)),
                       "over_rate": float((h.y > h.line).mean()), "model_over": float(h.p_over.mean()),
                       "beat_projection": float((h.y > h.mu).mean()), "others_beat_projection": float((rest.y > rest.mu).mean())}
    return {"rule": f"Below his projection in each of his last {min_games} games while playing 20+ minutes",
            "shown_when": "The Due symbol appears only in markets where such players beat their projection at least as often as everyone else.",
            "markets": out}
