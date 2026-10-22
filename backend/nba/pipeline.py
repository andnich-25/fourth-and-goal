"""Build every NBA number the website shows and write it as JSON.

  python -m nba.pipeline                    # writes ../site-data/nba/ (the hosted site copies it to dist/data/nba)
  python -m nba.pipeline --out DIR

Steps: load box scores -> pregame features -> walk-forward per market (cached by month) -> gate against the
player-average baseline -> confidence tiers, Due study, same-game correlation -> projections for the next slate ->
freeze today's leans in the archive (first projection of the day is kept) -> grade earlier frozen leans -> JSON.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from engine.util import utcnow

from . import collect, correlation, history, predict, props, report, sources

SITE_ROWS_MIN_MINUTES = report.PROP_MIN_MINUTES  # books rarely list deep-bench players


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else round(f, 4)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    if isinstance(o, pd.Period):
        return str(o)
    return o


def _write(out: Path, name: str, obj) -> None:
    f = out / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(_clean(obj), separators=(",", ":")))


def results_dir() -> Path:
    return sources.data_dir() / "results"


def _norm(s: str) -> str:
    s = re.sub(r"[^a-z ]", "", s.lower().replace("-", " ").replace(".", ""))
    return " ".join(w for w in s.split() if w not in {"jr", "sr", "ii", "iii", "iv"})


# --------------------------------------------------------------------------- odds from the archive
def book_odds(day: str) -> dict:
    """Today's saved prices: game lines by team and player props by (normalized name, market)."""
    f = sources.archive_dir() / "odds" / f"{day}.json"
    if not f.exists():
        return {"games": {}, "props": {}, "fetched_at": None, "plan": None}
    s = json.loads(f.read_text())
    ev = {g["event_id"]: g for g in s.get("games", [])}
    games = {}
    for l in s.get("game_lines", []):
        g = ev.get(l["event_id"])
        if not g:
            continue
        k = (g["home"], g["away"])
        e = games.setdefault(k, {"totals": [], "spreads": {}})
        if l["market"] == "totals" and str(l["team"]).lower() == "over" and l["point"] is not None:
            e["totals"].append(l["point"])
        if l["market"] == "spreads" and l["team"] == g["home"] and l["point"] is not None:
            e["spreads"].setdefault("home", []).append(l["point"])
    games = {k: {"total": float(np.median(v["totals"])) if v["totals"] else None,
                 "home_spread": float(np.median(v["spreads"]["home"])) if v["spreads"].get("home") else None} for k, v in games.items()}
    pr: dict = {}
    for p in s.get("props", []):
        pr.setdefault((_norm(p["player"]), p["market"]), []).append(
            {"book": p["book"], "side": p["side"], "line": p["line"], "price": p["price"]})
    return {"games": games, "props": pr, "fetched_at": s.get("fetched_at"), "plan": (s.get("budget") or {}).get("plan")}


def _consensus_line(offers: list[dict]) -> float | None:
    lines = [o["line"] for o in offers if o.get("line") is not None]
    if not lines:
        return None
    vals, counts = np.unique(lines, return_counts=True)
    return float(vals[np.argmax(counts)])


# --------------------------------------------------------------------------- pipeline
def run(out: Path, log=print, today: str | None = None) -> dict:
    today = today or collect.today_et()
    t0 = datetime.now(timezone.utc)
    d = history.load_box()
    f = history.build_features(d)
    log(f"nba: {d.game_id.nunique():,} games, {int(d.played.sum()):,} player-games, features ready")
    res_dir = results_dir()
    res_dir.mkdir(parents=True, exist_ok=True)
    oos, reports = {}, {}
    for market in props.MARKETS:
        cache = res_dir / f"wf_{market}.pkl"
        cached = pd.read_pickle(cache) if cache.exists() else None
        r = props.walk_forward(f, market, cached=cached, log=log)
        r.to_pickle(cache)
        oos[market] = r
        reports[market] = report.market_report(r, market)
        log(f"nba gate {market}: validated={reports[market]['validated']} failed={reports[market]['failed_checks']}")
    validated = {m for m, rp in reports.items() if rp["validated"]}
    conf = report.confidence(oos, validated)
    due = report.due_study(oos)
    cor = correlation.run({m: oos[m] for m in validated}, log=log) if validated else None

    # calibration for live projections: the most recent 12 months of out-of-sample predictions
    calib = {}
    for market, r in oos.items():
        recent = r[r.month.isin(sorted(r.month.unique())[-12:])]
        bands = props.fit_alpha_bands(recent.y.to_numpy(), recent.mu.to_numpy(), recent.min_l.to_numpy())
        calib[market] = {"alpha_bands": bands, "platt": props.fit_platt(recent, bands)}

    sched = predict.load_schedule()
    slate = predict.next_slate(sched, today)
    proj = predict.project(d, slate, calib, log=log) if len(slate) else pd.DataFrame()
    odds = book_odds(today)
    # Due is shown only in markets where, in testing, such players beat their projection at least as often as others.
    due_markets = {m for m, v in due["markets"].items() if v["beat_projection"] >= v["others_beat_projection"]}
    rows = slate_json(proj, f, oos, reports, odds, due_markets) if len(proj) else []
    games = [{"game_id": g.game_id, "date": str(g.game_date.date()), "time": g.game_date_time, "home": g.home_abbreviation,
              "away": g.away_abbreviation, **odds["games"].get((g.home_abbreviation, g.away_abbreviation), {})}
             for g in slate.itertuples()]
    slate_date = str(slate.game_date.min().date()) if len(slate) else None
    frozen = freeze(slate_date, rows) if slate_date else None
    rec = record(d)

    out.mkdir(parents=True, exist_ok=True)
    _write(out, "slate.json", {"date": slate_date, "generated_at": utcnow(), "games": games, "rows": rows,
                               "odds": {"fetched_at": odds["fetched_at"], "plan": odds["plan"],
                                        "props_priced": bool(odds["props"])}})
    _write(out, "markets.json", {"markets": list(reports.values()),
                                 "note": "Each market must beat the player-average baseline on games it never saw before over/under chances are shown."})
    _write(out, "confidence.json", conf)
    _write(out, "due.json", due)
    _write(out, "correlation.json", cor or {"use_correlation": False, "buckets": {}})
    _write(out, "record.json", rec)
    players = player_pages(d, rows)
    for pid, page in players.items():
        _write(out, f"players/{pid}.json", page)
    status = {"generated_at": utcnow(), "seconds": (datetime.now(timezone.utc) - t0).total_seconds(),
              "season": sources.CURRENT_SEASON, "season_label": f"{sources.CURRENT_SEASON - 1}-{str(sources.CURRENT_SEASON)[2:]}",
              "history": {"first_season": int(d.season.min()), "games": int(d.game_id.nunique()),
                          "player_games": int(d.played.sum()),
                          "last_game_date": str(d[d.played].game_date.max().date())},
              "slate_date": slate_date, "slate_games": len(games), "projected_players": len({r["player_id"] for r in rows}),
              "validated_markets": sorted(validated), "recency_half_life_seasons": props.RECENCY_HALF_LIFE,
              "frozen": frozen, "license": sources.LICENSE_NOTE,
              "injuries_as_of": next(iter(predict.injuries().values()), {}).get("as_of")}
    _write(out, "status.json", status)
    log(f"nba: wrote site data for {slate_date} ({len(rows)} rows, {len(players)} player pages) in {status['seconds']:.0f}s")
    return status


def slate_json(proj: pd.DataFrame, f: pd.DataFrame, oos: dict, reports: dict, odds: dict, due_markets: set[str]) -> list[dict]:
    played = f[f.played].sort_values("game_date")
    last = {m: played.groupby("player_id")[m].apply(lambda s: s.tail(10).tolist()[::-1]) for m in props.MARKETS}
    mins = played.groupby("player_id").minutes.apply(lambda s: s.tail(10).tolist()[::-1])
    rows = []
    for r in proj.itertuples():
        if (r.min_l or 0) < SITE_ROWS_MIN_MINUTES:
            continue
        m = r.market
        offers = odds["props"].get((_norm(r.player_name), m), [])
        book_line = _consensus_line(offers)
        line = book_line if book_line is not None else (r.line if r.line == r.line else math.floor(r.mu) + 0.5)
        dist = r.dist
        validated = reports[m]["validated"]
        po = p_over_dist(dist, line) if validated else None
        recent = last[m].get(r.player_id, [])
        rows.append({
            "player_id": str(int(r.player_id)), "player_name": r.player_name, "team": r.team, "opp": r.opp, "pos": r.pos,
            "home": int(r.home), "headshot": r.headshot, "game_id": int(r.game_id), "injury": r.injury or None,
            "injury_note": r.injury_note or None, "out": bool(r.out), "market": m, "mean": r.mu, "q10": r.q10, "q90": r.q90,
            "line": line, "line_source": "book" if book_line is not None else "usual", "usual_line": r.line,
            "dist": dist if validated else None, "p_over": po,
            "offers": [o for o in offers if o["line"] == line] if book_line is not None else [],
            "recent": recent, "recent_minutes": mins.get(r.player_id, []),
            "evidence": {"minutes": r.min_s, "minutes_long": r.min_l, "per_min": getattr(r, f"{m}_pm_l"),
                         "opp_mult": getattr(r, f"opp_{m}"), "pace": r.pace, "opp_pace": r.opp_pace, "rest": r.rest,
                         "start_rate": r.start_rate},
            "due": bool(m in due_markets and len(recent) >= 4 and all(v < r.mu for v in recent[:4]) and (r.min_l or 0) >= 20),
        })
    return rows


def p_over_dist(dist: dict, line: float) -> float:
    """Same rule as frontend pOver: clamp the raw tail, then the logistic recalibration."""
    k = int(math.floor(line))
    cdf = dist["cdf"]
    raw = 0.995 if k < 0 else 0.005 if k >= len(cdf) else 1 - cdf[k]
    raw = min(0.995, max(0.005, raw))
    a, b = dist.get("platt") or (1.0, 0.0)
    z = a * math.log(raw / (1 - raw)) + b
    return min(0.995, max(0.005, 1 / (1 + math.exp(-z))))


# --------------------------------------------------------------------------- frozen leans and the live record
def freeze(day: str, rows: list[dict]) -> dict:
    """Save the day's leans once, before games start. Later runs the same day never overwrite them."""
    f = sources.archive_dir() / "picks" / f"{day}.json"
    if f.exists():
        return {"date": day, "kept": True}
    picks = [{"player_id": r["player_id"], "player_name": r["player_name"], "team": r["team"], "game_id": r["game_id"],
              "market": r["market"], "line": r["line"], "line_source": r["line_source"], "p_over": round(r["p_over"], 4),
              "offers": r["offers"]}
             for r in rows if r["p_over"] is not None and not r["out"] and r["line"] >= report.MIN_LINE]
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"date": day, "frozen_at": utcnow(), "picks": picks}))
    return {"date": day, "kept": False, "picks": len(picks)}


def _decimal(american: int) -> float:
    return 1 + (american / 100 if american > 0 else 100 / -american)


def record(d: pd.DataFrame) -> dict:
    """Grade every frozen lean whose game is final: hit rate by confidence band, and flat-stake results where a book
    price was saved and our chance beat the price's implied chance by 3+ points."""
    files = sorted((sources.archive_dir() / "picks").glob("*.json"))
    rows = []
    box = d[d.played].set_index(["game_id", "player_id"])
    for fp in files:
        s = json.loads(fp.read_text())
        for p in s["picks"]:
            key = (int(float(p["game_id"])), int(float(p["player_id"])))
            if key not in box.index:
                continue
            val = float(box.loc[key, p["market"]] if p["market"] != "pra" else box.loc[key, "pra"])
            side = "over" if p["p_over"] >= 0.5 else "under"
            lean = max(p["p_over"], 1 - p["p_over"])
            won = int((val > p["line"]) == (side == "over"))
            prices = [o["price"] for o in p.get("offers", []) if o["side"] == side]
            best = max(prices, key=_decimal) if prices else None
            rows.append({"date": s["date"], "market": p["market"], "side": side, "lean": lean, "won": won,
                         "best": best, "edge": lean - 1 / _decimal(best) if best else None})
    if not rows:
        return {"days": 0, "picks": 0, "empty_reason": "The live record starts with the first slate the site projects; "
                                                        "each day's leans are frozen before tip-off and graded the next morning."}
    r = pd.DataFrame(rows)
    lean, hit = r.lean.to_numpy(), r.won.to_numpy()
    priced = r[r.edge.notna() & (r.edge > 0.03)]
    units = float(sum(_decimal(b) - 1 if w else -1 for b, w in zip(priced.best, priced.won)))
    return {"days": int(r.date.nunique()), "picks": int(len(r)), "first_date": r.date.min(), "last_date": r.date.max(),
            "tiers": report.tier_rows(lean, hit),
            "by_market": [{"market": m, "label": props.MARKETS[m], "n": int(len(g)), "rate": float(g.won.mean()),
                           "strong_n": int((g.lean >= 0.6).sum()),
                           "strong_rate": float(g[g.lean >= 0.6].won.mean()) if (g.lean >= 0.6).any() else None}
                          for m, g in r.groupby("market")],
            "vs_books": {"picks": int(len(priced)), "wins": int(priced.won.sum()), "units": units,
                         "roi": units / len(priced) if len(priced) else None}}


# --------------------------------------------------------------------------- player pages
def player_pages(d: pd.DataFrame, rows: list[dict]) -> dict:
    ids = {r["player_id"] for r in rows}
    d = d[d.player_id.notna()]
    played = d[d.played & d.player_id.astype("int64").astype(str).isin(ids)].sort_values("game_date")
    pages = {}
    for pid, g in played.groupby(played.player_id.astype("int64").astype(str)):
        g = g.tail(30)
        last = g.iloc[-1]
        pages[pid] = {
            "player_id": pid, "player_name": last.player_name, "team": last.team, "pos": last.pos, "headshot": last.headshot,
            "log": [{"date": str(x.game_date.date()), "opp": x.opp, "home": int(x.home), "minutes": x.minutes, "starter": int(x.starter),
                     "points": x.points, "rebounds": x.rebounds, "assists": x.assists, "threes": x.threes, "pra": x.pra}
                    for x in g.iloc[::-1].itertuples()],
            "props": [r for r in rows if r["player_id"] == pid],
        }
    return pages


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="nba.pipeline")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "site-data" / "nba"))
    ap.add_argument("--today")
    a = ap.parse_args(argv)
    run(Path(a.out), today=a.today)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
