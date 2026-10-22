"""Build every college football number the website shows and write it as JSON.

  python -m cfb.pipeline                    # writes ../site-data/cfb/ (the hosted site copies it to dist/data/cfb)
  python -m cfb.pipeline --out DIR

Steps: scores + closing lines -> weekly ratings -> walk-forward game model -> 5,000-game backtest of every market ->
proven tiers -> this week's lines (sportsbooks, then ESPN) -> 5,000 simulations per game -> picks only from proven
tiers -> player props for the featured games -> freeze each game's picks on game day -> grade earlier picks -> JSON.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from engine.util import utcnow

from . import collect, history, model, props, report, sources

FREEZE_HOURS = 36      # a game's picks are frozen on the run before kickoff, within this many hours of it
WEEK_DAYS = 8


def _clean(o):
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return [_clean(v) for v in o.tolist()]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else round(f, 4)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    return o


def _write(out: Path, name: str, obj) -> None:
    f = out / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(_clean(obj), separators=(",", ":")))


def _norm(s: str) -> str:
    s = re.sub(r"[^a-z ]", "", s.lower().replace("-", " ").replace(".", "").replace("'", ""))
    return " ".join(w for w in s.split() if w not in {"jr", "sr", "ii", "iii", "iv"})


# --------------------------------------------------------------------------- this week's lines
def live_lines(today: str) -> dict:
    """Per game: the consensus line from saved sportsbook prices (latest pull in the last week that priced the game),
    falling back to ESPN's posted line from today's scoreboard; every book's offer; team totals and props."""
    arch = sources.archive_dir()
    espn = {}
    sb = arch / "scoreboard" / f"{today}.json"
    if not sb.exists():
        older = sorted((arch / "scoreboard").glob("*.json")) if (arch / "scoreboard").exists() else []
        sb = older[-1] if older else None
    if sb:
        espn = {r["game_id"]: r for r in collect.parse_scoreboard(json.loads(sb.read_text()))}
    books: dict = {}
    tts: dict = {}
    prs: dict = {}
    fetched: dict = {}
    day = datetime.fromisoformat(today)
    for i in range(6, -1, -1):
        f = arch / "odds" / f"{day - timedelta(days=i):%Y-%m-%d}.json"
        if not f.exists():
            continue
        s = json.loads(f.read_text())
        got: dict = {}
        for l in s.get("game_lines", []):
            got.setdefault(l["game_id"], []).append(l)
        for gid, ls in got.items():       # a later pull replaces an earlier one game by game
            books[gid] = ls
            fetched[gid] = s.get("fetched_at")
        for t in s.get("team_totals", []):
            tts.setdefault(t["game_id"], []).append(t)
        for p in s.get("props", []):
            prs.setdefault(p["game_id"], []).append(p)
    out = {}
    for gid in set(espn) | set(books):
        e = espn.get(gid, {})
        ls = books.get(gid, [])
        sp = [l["point"] for l in ls if l["market"] == "spreads" and l["side"] == "home" and l["point"] is not None]
        tot = [l["point"] for l in ls if l["market"] == "totals" and l["side"] == "over" and l["point"] is not None]
        ml = {s: [l for l in ls if l["market"] == "h2h" and l["side"] == s and l["price"] is not None] for s in ("home", "away")}
        mlp = {s: float(history.american(np.median(history.implied(np.array([l["price"] for l in v], float)))))
               if v else None for s, v in ml.items()}
        row = {
            "spread": float(np.median(sp)) if sp else e.get("home_spread"),
            "total": float(np.median(tot)) if tot else e.get("total"),
            "ml_home": mlp["home"] if mlp["home"] is not None else e.get("ml_home"),
            "ml_away": mlp["away"] if mlp["away"] is not None else e.get("ml_away"),
            "source": f"{len({l['book'] for l in ls})} sportsbooks" if sp or tot else (f"ESPN ({e['provider']})" if e.get("provider") else "ESPN") if e.get("home_spread") is not None or e.get("total") is not None else None,
            "fetched_at": fetched.get(gid) or (json.loads(sb.read_text()).get("fetched_at") if sb else None),
            "offers": ls, "team_totals": tts.get(gid, []), "props": prs.get(gid, []),
            "home_rank": e.get("home_rank"), "away_rank": e.get("away_rank"), "tv": e.get("tv"),
        }
        out[gid] = row
    return out


def _best(offers: list[dict], **match) -> dict | None:
    best = None
    for o in offers:
        if all(o.get(k) == v for k, v in match.items()) and o.get("price") is not None:
            if best is None or history.decimal(np.array([o["price"]]))[0] > history.decimal(np.array([best["price"]]))[0]:
                best = o
    return {"price": int(best["price"]), "book": best["book"]} if best else None


# --------------------------------------------------------------------------- picks for the week
def tier_of(tiers: list[dict], p: float, key: str = "p") -> dict | None:
    for t in tiers:
        if t["lo"] <= p < (t["hi"] if t["hi"] < 1 else 99):
            return t
    return None


def game_rows(up: pd.DataFrame, ch: dict, summary: dict, lines: dict) -> list[dict]:
    mk = summary["markets"]
    rows = []
    for i, g in enumerate(up.itertuples()):
        L = lines.get(g.game_id, {})
        offers = L.get("offers", [])
        markets = []
        if g.spread == g.spread:
            p = float(ch["p_home_cover"][i])
            home = p >= 0.5
            line = g.spread if home else -g.spread
            t = tier_of(mk["spread"]["tiers"], max(p, 1 - p))
            markets.append({"market": "spread", "side": "home" if home else "away", "team": g.home_team if home else g.away_team,
                            "line": line, "p": max(p, 1 - p), "push": float(ch["push_spread"][i]), "tier": t["tier"] if t else None,
                            "proven": bool(t and t["proven"]),
                            "best": _best(offers, market="spreads", side="home" if home else "away", point=line)})
        if g.total == g.total:
            p = float(ch["p_over"][i])
            over = p >= 0.5
            t = tier_of(mk["total"]["tiers"], max(p, 1 - p))
            markets.append({"market": "total", "side": "over" if over else "under", "line": g.total, "p": max(p, 1 - p),
                            "push": float(ch["push_total"][i]), "tier": t["tier"] if t else None, "proven": bool(t and t["proven"]),
                            "best": _best(offers, market="totals", side="over" if over else "under", point=g.total)})
        for side, team in (("home", g.home_team), ("away", g.away_team)):
            line = getattr(g, f"tt_{side}")
            if line != line:
                continue
            p = float(ch[f"p_{side}_tt_over"][i])
            over = p >= 0.5
            posted = bool(getattr(g, f"tt_{side}_posted"))
            t = tier_of(mk["team_total"]["tiers"], max(p, 1 - p))
            tto = [o for o in L.get("team_totals", []) if o["team"] == side]
            markets.append({"market": "team_total", "team": team, "team_side": side, "side": "over" if over else "under",
                            "line": line, "line_posted": posted, "p": max(p, 1 - p), "tier": t["tier"] if t else None,
                            # hit rates count only lines books actually post, so implied team totals are never picks
                            "proven": bool(t and t["proven"] and posted),
                            "best": _best([{**o, "market": "tt"} for o in tto], market="tt", side="over" if over else "under", line=line)})
        if g.ml_home == g.ml_home and g.ml_away == g.ml_away:
            ph = float(ch["p_home_win"][i])
            bh = _best(offers, market="h2h", side="home") or {"price": int(g.ml_home), "book": None}
            ba = _best(offers, market="h2h", side="away") or {"price": int(g.ml_away), "book": None}
            evh = ph * history.decimal(np.array([bh["price"]]))[0] - 1
            eva = (1 - ph) * history.decimal(np.array([ba["price"]]))[0] - 1
            home = evh >= eva
            ev = max(evh, eva)
            price = bh["price"] if home else ba["price"]
            t = tier_of(mk["moneyline"]["tiers"], ev) if ev > 0 else None
            in_range = report.ML_PRICE_RANGE[0] <= price <= report.ML_PRICE_RANGE[1]
            markets.append({"market": "moneyline", "side": "home" if home else "away", "team": g.home_team if home else g.away_team,
                            "p": ph if home else 1 - ph, "price": price, "ev": ev, "tier": t["tier"] if t else None,
                            "proven": bool(t and t["proven"] and in_range), "best": bh if home else ba})
        for m in markets:
            m["score"] = round(m["p"] * 10, 1)
        rows.append({
            "game_id": int(g.game_id), "date": g.date.isoformat() + "Z", "week": int(g.week), "season_type": g.season_type,
            "home": g.home_team, "away": g.away_team, "home_id": int(g.home_id), "away_id": int(g.away_id),
            "home_conf": g.home_conference, "away_conf": g.away_conference, "neutral": bool(g.neutral),
            "conference_game": bool(g.conference_game), "venue": g.venue if isinstance(g.venue, str) else None,
            "home_rank": L.get("home_rank"), "away_rank": L.get("away_rank"), "tv": L.get("tv"), "featured": bool(g.featured),
            "line": {"spread": g.spread, "total": g.total, "ml_home": g.ml_home, "ml_away": g.ml_away,
                     "tt_home": g.tt_home, "tt_away": g.tt_away, "tt_posted": bool(g.tt_home_posted or g.tt_away_posted),
                     "source": L.get("source"), "fetched_at": L.get("fetched_at"), "has_line": bool(g.spread == g.spread)},
            "model": {"home": float(ch["home_mean"][i]), "away": float(ch["away_mean"][i]), "margin": float(g.pred_margin),
                      "total": float(g.pred_total), "margin_q": ch["margin_q"][i], "total_q": ch["total_q"][i],
                      "home_win": float(ch["p_home_win"][i]), "line_based": bool(g.spread == g.spread)},
            "ratings": {"home": _team_rating(g, "home"), "away": _team_rating(g, "away")},
            "markets": markets,
        })
    return rows


def _team_rating(g, side: str) -> dict:
    return {"pts_for": getattr(g, f"r_{side}"), "ypp": getattr(g, f"y_{side}", None), "plays": getattr(g, f"n_{side}", None),
            "games": getattr(g, f"{side}_games", None)}


def reasons(row: dict, m: dict) -> list[str]:
    """Plain-language reasons for a lean, from the numbers the model published."""
    md = row["model"]
    out = []
    if m["market"] == "spread":
        fav = row["home"] if row["line"]["spread"] < 0 else row["away"]
        exp = md["margin"]
        out.append(f"Model margin: {row['home'] if exp >= 0 else row['away']} by {abs(exp):.1f}; "
                   f"the line has {fav} by {abs(row['line']['spread']):.1f}.")
    elif m["market"] == "total":
        out.append(f"Model total {md['total']:.1f} vs the line {row['line']['total']}; 80% of simulated games land "
                   f"between {md['total_q'][0]:.0f} and {md['total_q'][2]:.0f}.")
        if row["line"]["total"] >= 65:
            out.append("Totals of 65+ have gone under about 54% of the time in both 2014-21 and 2022-26.")
        if row["neutral"]:
            out.append("Neutral-site games have gone under more often than not in both eras tested.")
    elif m["market"] == "team_total":
        exp = md["home"] if m["team_side"] == "home" else md["away"]
        out.append(f"Model has {m['team']} scoring {exp:.1f}; the {'posted' if m['line_posted'] else 'implied'} team total is {m['line']}.")
    elif m["market"] == "moneyline":
        out.append(f"{m['team']} wins {m['p'] * 100:.0f}% of 5,000 simulated games; at {m['price']:+d} that is "
                   f"{m['ev'] * 100:+.1f} cents per dollar.")
    return out


# --------------------------------------------------------------------------- frozen picks and the live record
def freeze(rows: list[dict], now: datetime) -> dict:
    """Save each game's leans once, on the last run before kickoff (within FREEZE_HOURS). Never overwritten."""
    d = sources.archive_dir() / "picks"
    d.mkdir(parents=True, exist_ok=True)
    frozen = 0
    for r in rows:
        ko = datetime.fromisoformat(r["date"].replace("Z", "+00:00"))
        if not (now < ko <= now + timedelta(hours=FREEZE_HOURS)) or not r["line"]["has_line"]:
            continue
        f = d / f"{r['game_id']}.json"
        if f.exists():
            continue
        f.write_text(json.dumps(_clean({"game_id": r["game_id"], "date": r["date"], "home": r["home"], "away": r["away"],
                                        "frozen_at": utcnow(), "line": r["line"], "featured": r["featured"],
                                        "markets": r["markets"]})))
        frozen += 1
    return {"frozen": frozen}


def record(g: pd.DataFrame, summary: dict) -> dict:
    """Grade every frozen pick whose game is final, by market and tier, at the line it was frozen with."""
    files = sorted((sources.archive_dir() / "picks").glob("*.json")) if (sources.archive_dir() / "picks").exists() else []
    fin = g[g.final].set_index("game_id")
    rows = []
    for fp in files:
        s = json.loads(fp.read_text())
        gid = int(s["game_id"])
        if gid not in fin.index:
            continue
        x = fin.loc[gid]
        hp, ap = float(x.home_points), float(x.away_points)
        for m in s["markets"]:
            if m["market"] == "spread":
                diff = (hp - ap) + m["line"] if m["side"] == "home" else (ap - hp) + m["line"]
            elif m["market"] == "total":
                diff = (hp + ap - m["line"]) * (1 if m["side"] == "over" else -1)
            elif m["market"] == "team_total":
                pts = hp if m["team_side"] == "home" else ap
                diff = (pts - m["line"]) * (1 if m["side"] == "over" else -1)
            else:
                diff = (hp - ap) * (1 if m["side"] == "home" else -1)
            if diff == 0:
                continue
            won = int(diff > 0)
            ret = None
            if m["market"] == "moneyline":
                ret = won * float(history.decimal(np.array([m["price"]]))[0]) - 1
            rows.append({"game_id": gid, "date": s["date"][:10], "market": m["market"], "tier": m.get("tier"),
                         "proven": bool(m.get("proven")), "p": m["p"], "won": won, "ret": ret,
                         "label": f"{s['away']} at {s['home']}", "side": m.get("team") or m["side"], "line": m.get("line"),
                         "posted": m.get("line_posted", True)})
    if not rows:
        return {"games": 0, "picks": 0, "empty_reason": "The live record starts with this week's games: every game's leans "
                                                         "are frozen on game day before kickoff and graded once the final is in."}
    r = pd.DataFrame(rows)
    by = []
    for (mkt, tier), x in r.groupby(["market", "tier"], dropna=False):
        by.append({"market": mkt, "tier": tier, "n": int(len(x)), "hits": int(x.won.sum()), "rate": float(x.won.mean()),
                   "roi": float(x.ret.mean()) if mkt == "moneyline" and x.ret.notna().any() else None})
    pk = r[r.proven]
    return {"games": int(r.game_id.nunique()), "picks": int(len(r)), "first_date": r.date.min(), "last_date": r.date.max(),
            "by_market_tier": by,
            "suggested": {"n": int(len(pk)), "hits": int(pk.won.sum()), "rate": float(pk.won.mean()) if len(pk) else None},
            "recent": r[r.proven].sort_values("date", ascending=False).head(40).to_dict("records")}


# --------------------------------------------------------------------------- teams
def team_table(g: pd.DataFrame, season: int) -> list[dict]:
    """This season's record, against the spread and over/under, plus current ratings, for every FBS team."""
    now = pd.Timestamp(datetime.now(timezone.utc).replace(tzinfo=None))
    rt = {pre: history_rating(g, now, pre) for pre in ("r", "y", "n")}
    s = g[(g.season == season) & g.final]
    out = []
    fbs = set(s[s.home_division == "fbs"].home_id) | set(s[s.away_division == "fbs"].away_id)
    for tid in fbs:
        h = s[s.home_id == tid]
        a = s[s.away_id == tid]
        name = (h.home_team.iloc[0] if len(h) else a.away_team.iloc[0])
        conf = (h.home_conference.iloc[0] if len(h) else a.away_conference.iloc[0])
        mar = pd.concat([h.margin, -a.margin])
        ats = pd.concat([np.sign(h.margin + h.spread), np.sign(-a.margin - a.spread)]).dropna()
        ou = pd.concat([np.sign(h.pts - h.total), np.sign(a.pts - a.total)]).dropna()
        r = rt["r"]
        out.append({"team_id": int(tid), "team": name, "conference": conf if isinstance(conf, str) else None,
                    "w": int((mar > 0).sum()), "l": int((mar < 0).sum()),
                    "ats_w": int((ats > 0).sum()), "ats_l": int((ats < 0).sum()), "ats_p": int((ats == 0).sum()),
                    "over": int((ou > 0).sum()), "under": int((ou < 0).sum()),
                    "off": r["off"].get(tid), "def": r["def"].get(tid),
                    "ypp_off": rt["y"]["off"].get(tid), "ypp_def": rt["y"]["def"].get(tid), "pace": rt["n"]["off"].get(tid)})
    base = rt["r"]["base"]
    for t in out:
        t["net"] = (t["off"] + t["def"]) if t["off"] is not None and t["def"] is not None else None
        t["pts_for"] = base + t["off"] if t["off"] is not None else None
        t["pts_against"] = base - t["def"] if t["def"] is not None else None
        yb, nb = rt["y"]["base"], rt["n"]["base"]
        t["ypp_for"] = yb + t["ypp_off"] if t["ypp_off"] is not None else None
        t["ypp_against"] = yb - t["ypp_def"] if t["ypp_def"] is not None else None
        t["plays"] = nb + t["pace"] if t["pace"] is not None else None
    out.sort(key=lambda t: -(t["net"] or -99))
    for i, t in enumerate(out):
        t["power_rank"] = i + 1
    return out


def history_rating(g: pd.DataFrame, now: pd.Timestamp, pre: str) -> dict:
    from . import ratings  # noqa: PLC0415
    spec = next(s for s in model.RATINGS if s[0] == pre)
    return ratings.fit(g, now, spec[3], spec[4], spec[1], spec[2])


# --------------------------------------------------------------------------- props for featured games
def prop_rows(g: pd.DataFrame, oos: pd.DataFrame, up: pd.DataFrame, featured: set[int], lines: dict, log=print) -> tuple[list[dict], dict]:
    first = sources.CURRENT_SEASON - sources.PROP_SEASONS - 2
    pg = props.load_player_games(first)
    if pg.empty or not featured:
        return [], {"markets": {}, "note": "No featured games this week."}
    preds = pd.concat([oos[["game_id", "pred_home", "pred_away"]], up[["game_id", "pred_home", "pred_away"]]])
    gg = g[g.season >= first].drop(columns=[c for c in ("pred_home", "pred_away") if c in g]).merge(preds, on="game_id", how="left")
    d = props.attach_games(pg, gg)
    # tonight's rows: one per player who has played for a featured team this season and is a regular in a market
    fut = []
    for gid in featured:
        x = gg[gg.game_id == gid]
        if x.empty:
            continue
        x = x.iloc[0]
        for side, opp in (("home", "away"), ("away", "home")):
            roster = d[(d.team_id == x[f"{side}_id"]) & (d.season == x.season)].drop_duplicates("athlete_id")
            if roster.empty:
                continue
            fut.append(pd.DataFrame({"game_id": gid, "athlete_id": roster.athlete_id.to_numpy(),
                                     "athlete_name": roster.athlete_name.to_numpy(), "team_id": x[f"{side}_id"],
                                     "opp_id": x[f"{opp}_id"], "team": x[f"{side}_team"], "opp": x[f"{opp}_team"],
                                     "home": int(side == "home"), "date": x.date, "season": x.season,
                                     "exp_pts": x[f"pred_{side}"]}))
    if not fut:
        return [], {"markets": {}, "note": "No player history for this week's featured games."}
    fut = pd.concat(fut, ignore_index=True)
    for c in ("pass_yds", "pass_td", "pass_att", "rush_yds", "rush_att", "rec_yds", "receptions"):
        fut[c] = np.nan
    allp = pd.concat([d, fut], ignore_index=True).sort_values(["date", "game_id"]).reset_index(drop=True)
    f = props.features(allp)
    hist = f[f.pass_yds.notna()]
    wf = props.walk_forward(hist, sources.CURRENT_SEASON - sources.PROP_SEASONS + 1, log=log)
    tiers = {}
    for m in props.MARKETS:
        r = wf[(wf.market == m) & (wf.y != wf.line)]
        dd = pd.DataFrame({"p": np.maximum(r.p_over, 1 - r.p_over), "won": np.where(r.p_over >= 0.5, r.y > r.line, r.y < r.line).astype(int),
                           "season": r.season})
        seasons = sorted(dd.season.unique())
        tiers[m] = {"label": props.MARKETS[m], "tiers": report.tier_rows(dd, tiers=PROP_TIERS, recent=seasons[-2:]),
                    "n": int(len(dd)), "line": "usual"}
    now_rows = f[f.pass_yds.isna()]
    out = []
    for m in props.MARKETS:
        r, ratios = props.fit(hist, m)
        t = now_rows[props.eligible(now_rows, m)]
        if t.empty:
            continue
        mu = np.expm1(r.predict(props.design(t, m))).clip(min=0.5)
        usual = props.usual_line(allp, m).loc[t.index]
        for (_, x), mu_i, ul in zip(t.iterrows(), mu, usual):
            offers = [o for o in lines.get(int(x.game_id), {}).get("props", []) if o["market"] == m and _norm(o["player"]) == _norm(x.athlete_name)]
            book_lines = [o["line"] for o in offers if o.get("line") is not None]
            line = float(pd.Series(book_lines).mode().iloc[0]) if book_lines else (ul if ul == ul else math.floor(mu_i) + 0.5)
            po = float(props.p_over(np.array([mu_i]), ratios, np.array([line]))[0])
            side = "over" if po >= 0.5 else "under"
            p = max(po, 1 - po)
            tr = tier_of(tiers[m]["tiers"], p)
            recent = hist[hist.athlete_id == x.athlete_id].sort_values("date").tail(8)[m].tolist()[::-1]
            out.append({"game_id": int(x.game_id), "player": x.athlete_name, "player_id": str(int(x.athlete_id)), "team": x.team,
                        "opp": x.opp, "market": m, "label": props.MARKETS[m], "mean": float(mu_i), "line": line,
                        "line_source": "book" if book_lines else "usual", "p_over": po, "side": side, "p": p,
                        "score": round(p * 10, 1), "tier": tr["tier"] if tr else None,
                        # picks only at lines books post
                        "proven": bool(tr and tr["proven"] and book_lines), "recent": recent,
                        "best": _best([{**o, "market": "p"} for o in offers], market="p", side=side, line=line)})
    out.sort(key=lambda r: -r["p"])
    return out, {"markets": tiers, "note": "Backtest at each player's usual line (median of his last five games); books' "
                                           "prop lines are sharper, so the live record on posted lines is what counts."}


PROP_TIERS = [("Coin flip", 0.50, 0.55), ("Lean", 0.55, 0.60), ("Solid", 0.60, 0.65), ("Strong", 0.65, 1.0)]


# --------------------------------------------------------------------------- pipeline
def run(out: Path, log=print, today: str | None = None, now: datetime | None = None) -> dict:
    today = today or collect.today_et()
    now = now or datetime.now(timezone.utc)
    t0 = datetime.now(timezone.utc)
    g = history.load_games()
    g = g.merge(history.load_team_box(), on="game_id", how="left")
    lines = live_lines(today)
    # this week's games take the live line (closing lines arrive upstream after the games)
    nowts = pd.Timestamp(now.replace(tzinfo=None))
    upcoming = (~g.final) & (g.date >= nowts - pd.Timedelta(hours=4)) & (g.date < nowts + pd.Timedelta(days=WEEK_DAYS))
    for c, k in (("spread", "spread"), ("total", "total"), ("ml_home", "ml_home"), ("ml_away", "ml_away")):
        vals = g.loc[upcoming, "game_id"].map(lambda gid: lines.get(gid, {}).get(k))
        g.loc[upcoming, c] = pd.to_numeric(vals, errors="coerce")
    g = g.join(model.rate(g, sources.FIRST_SEASON + 2))
    log(f"cfb: {int(g.final.sum()):,} finished games, {int(upcoming.sum())} this week")
    oos = model.walk_forward(g, sources.FIRST_TEST_SEASON, log=log)
    bt = report.simulate_backtest(oos)
    summary = report.summarize(bt)
    opening = report.opening_totals(oos, bt)
    finds = report.findings(g)
    for m, v in summary["markets"].items():
        log(f"cfb backtest {m}: proven tiers {[t['tier'] for t in v['tiers'] if t['proven']]}")

    up = g[upcoming].copy()
    rows, props_rows, prop_tiers, coefs = [], [], {"markets": {}}, {}
    if len(up):
        up, coefs = model.fit_live(g, up)
        for side in ("home", "away"):
            posted = up.game_id.map(lambda gid: _posted_tt(lines.get(gid, {}), side))
            up[f"tt_{side}_posted"] = posted.notna()
            up[f"tt_{side}"] = posted.where(posted.notna(), model.implied_team_total(up.spread, up.total, side))
        rank = up.game_id.map(lambda gid: _rank_score(lines.get(gid, {})))
        if rank.notna().any() or any(L.get("home_rank") or L.get("away_rank") for L in lines.values()):
            up["featured"] = rank.notna()
        else:   # no AP ranks saved (ESPN unreachable): both teams in our top 25
            top = {t["team_id"] for t in team_table(g, sources.CURRENT_SEASON)[:25]}
            up["featured"] = up.home_id.isin(top) & up.away_id.isin(top)
        up["featured"] |= up.game_id.map(lambda gid: bool(lines.get(gid, {}).get("props")))
        up = up.sort_values(["date", "game_id"]).reset_index(drop=True)
        pool = model.miss_pool(oos, nowts)
        h, a = model.simulate(up.pred_home.to_numpy(), up.pred_away.to_numpy(), pool, seed=7)
        # games without a posted line are still simulated (for the projection), at a placeholder line nobody sees
        sp = up.spread.fillna(0.5).to_numpy()
        tot = up.total.fillna(50.5).to_numpy()
        ch = model.chances(h, a, sp, tot, up.tt_home.fillna(0).to_numpy(), up.tt_away.fillna(0).to_numpy())
        rows = game_rows(up, ch, summary, lines)
        for r in rows:
            for m in r["markets"]:
                m["reasons"] = reasons(r, m)
        featured = {r["game_id"] for r in rows if r["featured"]}
        try:
            props_rows, prop_tiers = prop_rows(g, oos, up, featured, lines, log=log)
        except Exception as ex:  # noqa: BLE001 - props are a side dish; the game lines still publish
            log(f"cfb props: skipped ({ex})")
    frozen = freeze(rows, now)
    rec = record(g, summary)
    teams = team_table(g, sources.CURRENT_SEASON)

    picks = [{"game_id": r["game_id"], "date": r["date"], "home": r["home"], "away": r["away"], **m}
             for r in rows for m in r["markets"] if m["proven"]]
    picks.sort(key=lambda p: -p["p"])
    out.mkdir(parents=True, exist_ok=True)
    _write(out, "week.json", {"generated_at": utcnow(), "games": rows, "picks": picks,
                              "odds": {"books_games": sum(1 for r in rows if (r["line"]["source"] or "").endswith("sportsbooks")),
                                       "espn_games": sum(1 for r in rows if (r["line"]["source"] or "").startswith("ESPN")),
                                       "no_line": sum(1 for r in rows if not r["line"]["has_line"])}})
    _write(out, "props.json", {"generated_at": utcnow(), "rows": props_rows, "backtest": prop_tiers})
    _write(out, "backtest.json", {**summary, "opening_totals": opening, "coefficients": coefs,
                                  "model": {"ratings_half_life_days": model.RATINGS[0][3],
                                            "recency_half_life_seasons": model.RECENCY_HALF_LIFE, "sims": model.SIMS}})
    _write(out, "findings.json", {"rules": finds, "break_even": report.BREAK_EVEN})
    _write(out, "record.json", rec)
    _write(out, "teams.json", {"season": sources.CURRENT_SEASON, "teams": teams})
    fin = g[g.final]
    status = {"generated_at": utcnow(), "seconds": (datetime.now(timezone.utc) - t0).total_seconds(),
              "season": sources.CURRENT_SEASON, "games_this_week": len(rows), "picks": len(picks),
              "props": len(props_rows), "frozen": frozen,
              "history": {"first_season": int(fin.season.min()), "games": int(len(fin)),
                          "lined_games": int((fin.spread.notna()).sum()), "last_game_date": str(fin.date.max().date())},
              "proven": {m: [t["tier"] for t in v["tiers"] if t["proven"]] for m, v in summary["markets"].items()},
              "license": sources.LICENSE_NOTE}
    _write(out, "status.json", status)
    log(f"cfb: wrote site data ({len(rows)} games, {len(picks)} picks, {len(props_rows)} prop rows) in {status['seconds']:.0f}s")
    return status


def _posted_tt(L: dict, side: str) -> float | None:
    ls = [o["line"] for o in L.get("team_totals", []) if o["team"] == side and o.get("line") is not None]
    return float(pd.Series(ls).mode().iloc[0]) if ls else None


def _rank_score(L: dict) -> float | None:
    h, a = L.get("home_rank"), L.get("away_rank")
    if h and a:
        return h + a
    if min(h or 99, a or 99) <= 10:
        return 50 + min(h or 99, a or 99)
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="cfb.pipeline")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "site-data" / "cfb"))
    ap.add_argument("--today")
    a = ap.parse_args(argv)
    run(Path(a.out), today=a.today)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
