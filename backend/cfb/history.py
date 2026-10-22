"""College football game history: one row per game with the final score and the closing lines.

Lines are the median across books of each game's last posted spread (home side), total and moneylines, which is what
"the line" means on this site. Older seasons in the betting file name teams by short codes (UTH, TCU), newer ones by
name, so each code is matched to the team it appears with most often.
"""
from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np
import pandas as pd

from . import sources

SCHED_COLS = ["game_id", "season", "week", "season_type", "start_date", "completed", "neutral_site", "conference_game",
              "home_id", "home_team", "home_division", "home_conference", "home_points", "away_id", "away_team",
              "away_division", "away_conference", "away_points", "venue", "notes", "home_pregame_elo", "away_pregame_elo"]
DIVISIONS = {"fbs", "fcs"}


def _truthy(s: pd.Series) -> pd.Series:
    return s.astype(str).str.lower().isin(["true", "1", "1.0", "yes"])


def load_schedule(first: int = sources.FIRST_SEASON, last: int = sources.CURRENT_SEASON) -> pd.DataFrame:
    """Every FBS/FCS game first..last, finished or not. Division-II/III games are dropped."""
    frames = []
    for yr in range(first, last + 1):
        p = sources.raw_dir() / sources.local_name("schedule", yr)
        if p.exists():
            frames.append(pd.read_csv(p, low_memory=False, usecols=lambda c: c in SCHED_COLS))
    if not frames:
        raise FileNotFoundError(f"No college football schedules in {sources.raw_dir()}; run python -m cfb.collect first")
    s = pd.concat(frames, ignore_index=True)
    for side in ("home", "away"):
        div = s[f"{side}_division"].fillna("").str.lower()
        s[f"{side}_division"] = div
    # older files only list FBS teams' games, where the division column is sometimes blank
    keep = s.home_division.isin(DIVISIONS | {""}) & s.away_division.isin(DIVISIONS | {""})
    keep &= (s.home_division == "fbs") | (s.away_division == "fbs") | ((s.home_division == "fcs") & (s.away_division == "fcs"))
    keep |= s.season < 2014
    s = s[keep].copy()
    s["game_id"] = pd.to_numeric(s.game_id, errors="coerce")
    s = s.dropna(subset=["game_id", "home_id", "away_id"])
    s["game_id"] = s.game_id.astype("int64")
    s["home_id"] = s.home_id.astype("int64")
    s["away_id"] = s.away_id.astype("int64")
    s["date"] = pd.to_datetime(s.start_date, utc=True, errors="coerce").dt.tz_localize(None)
    s["neutral"] = _truthy(s.neutral_site)
    s["conference_game"] = _truthy(s.conference_game)
    s["final"] = s.home_points.notna() & s.away_points.notna()
    s["fbs_game"] = (s.home_division == "fbs") & (s.away_division == "fbs")
    return s.drop_duplicates("game_id").sort_values(["date", "game_id"]).reset_index(drop=True)


def _team_codes(lines: pd.DataFrame) -> dict:
    cnt: dict = defaultdict(Counter)
    for a, h, w in lines[["abbr", "home_id", "away_id"]].itertuples(index=False):
        cnt[a][h] += 1
        cnt[a][w] += 1
    return {a: c.most_common(1)[0][0] for a, c in cnt.items()}


def load_lines(sched: pd.DataFrame) -> pd.DataFrame:
    """Closing spread (home side; negative = home favored), total and moneylines per game, median across books."""
    p = sources.raw_dir() / sources.local_name("lines")
    cols = ["game_id", "market_type", "abbr", "lines", "odds", "opening_lines", "book"]
    if not p.exists():
        return pd.DataFrame(columns=["game_id"])
    l = pd.read_csv(p, low_memory=False, usecols=cols)
    l = l[l.game_id.notna()].copy()
    l["game_id"] = l.game_id.astype("int64")
    l = l.merge(sched[["game_id", "home_id", "away_id"]], on="game_id")
    l["tid"] = l.abbr.map(_team_codes(l[l.market_type != "total"]))
    l["is_home"] = np.where(l.tid == l.home_id, 1, np.where(l.tid == l.away_id, 0, -1))
    sp = l[(l.market_type == "spread") & l.lines.notna() & (l.is_home >= 0)].copy()
    sp["home_line"] = np.where(sp.is_home == 1, sp.lines, -sp.lines)
    sp["home_open"] = np.where(sp.is_home == 1, sp.opening_lines, -sp.opening_lines)
    spg = sp.groupby(["game_id", "book"]).agg(home_line=("home_line", "median"), home_open=("home_open", "median")).reset_index()
    spread = spg.groupby("game_id").agg(spread=("home_line", "median"), spread_open=("home_open", "median"),
                                        books=("book", "nunique"))
    tt = l[(l.market_type == "total") & l.lines.notna()]
    total = tt.groupby("game_id").agg(total=("lines", "median"), total_open=("opening_lines", "median"))
    # moneylines: the median price by its implied chance (a plain median of -105 and +105 would be 0)
    ml = l[(l.market_type == "money_line") & l.odds.notna() & (l.is_home >= 0) & (l.odds.abs() >= 100)].copy()
    ml["imp"] = implied(ml.odds.to_numpy(float))
    mh = ml[ml.is_home == 1].groupby("game_id").imp.median().rename("ml_home")
    ma = ml[ml.is_home == 0].groupby("game_id").imp.median().rename("ml_away")
    out = spread.join([total, mh, ma], how="outer")
    for c in ("ml_home", "ml_away"):
        out[c] = american(out[c].to_numpy(float))
    # a moneyline that disagrees with the spread on who is favored is a data error
    bad = (out.spread < -3) & (out.ml_home > 0) | (out.spread > 3) & (out.ml_away > 0)
    out.loc[bad, ["ml_home", "ml_away"]] = np.nan
    return out.reset_index()


def implied(american_odds: np.ndarray) -> np.ndarray:
    a = np.asarray(american_odds, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(a < 0, -a / (-a + 100), 100 / (a + 100))


def american(p: np.ndarray) -> np.ndarray:
    """Implied chance back to an American price (rounded to whole cents)."""
    p = np.asarray(p, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.round(np.where(p >= 0.5, -100 * p / (1 - p), 100 * (1 - p) / p))


def decimal(american_odds: np.ndarray) -> np.ndarray:
    a = np.asarray(american_odds, float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(a > 0, 1 + a / 100, 1 + 100 / -a)


def load_current_lines(season: int = sources.CURRENT_SEASON) -> pd.DataFrame:
    """This season's spread and total from the cfbfastR play-by-play (CollegeFootballData lines; negative = home
    favored), used until the betting file has the season."""
    p = sources.raw_dir() / sources.local_name("pbp", season)
    if not p.exists():
        return pd.DataFrame(columns=["game_id", "spread", "total"])
    d = pd.read_parquet(p, columns=["game_id", "spread", "over_under"])
    d = d.dropna(subset=["spread"]).groupby("game_id", as_index=False).first()
    d["game_id"] = d.game_id.astype("int64")
    return d.rename(columns={"over_under": "total"})


def load_games(first: int = sources.FIRST_SEASON, last: int = sources.CURRENT_SEASON) -> pd.DataFrame:
    """Schedule joined to closing lines; margin and points for finished games."""
    s = load_schedule(first, last)
    lines = load_lines(s)
    g = s.merge(lines, on="game_id", how="left")
    cur = load_current_lines(last)
    if len(cur):
        cur = cur.set_index("game_id")
        miss = g.spread.isna() & g.game_id.isin(cur.index)
        g.loc[miss, "spread"] = g.loc[miss, "game_id"].map(cur.spread)
        miss = g.total.isna() & g.game_id.isin(cur.index)
        g.loc[miss, "total"] = g.loc[miss, "game_id"].map(cur.total)
    g["margin"] = g.home_points - g.away_points
    g["pts"] = g.home_points + g.away_points
    return g


def _made_att(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.astype(str).str.split("[/-]").str[1], errors="coerce")


def load_team_box(first: int = sources.FIRST_SEASON, last: int = sources.CURRENT_SEASON) -> pd.DataFrame:
    """Per game and side: plays (rushes + passes), yards per play and turnovers, from ESPN team box scores."""
    frames = []
    for yr in range(first, last + 1):
        p = sources.raw_dir() / sources.local_name("team_box", yr)
        if p.exists():
            frames.append(pd.read_csv(p, low_memory=False))
    if not frames:
        return pd.DataFrame(columns=["game_id"])
    t = pd.concat(frames, ignore_index=True)
    t["plays"] = pd.to_numeric(t.rushingAttempts, errors="coerce") + _made_att(t.completionAttempts)
    t["yards"] = pd.to_numeric(t.totalYards, errors="coerce")
    t["to"] = pd.to_numeric(t.turnovers, errors="coerce")
    t = t[(t.plays > 20) & t.yards.notna()]
    t["ypp"] = t.yards / t.plays
    w = t.pivot_table(index="game_id", columns="home_away", values=["plays", "ypp", "to"], aggfunc="first")
    w.columns = [f"{side}_{m}" for m, side in w.columns]
    w = w.reset_index()
    w["game_id"] = w.game_id.astype("int64")
    return w


PBP_COLS = ["game_id", "period", "pos_team", "home", "home_team_id", "away_team_id", "pos_team_score", "def_pos_team_score",
            "rush", "pass", "EPA", "success", "yards_gained"]


def aggregate_pbp(path) -> pd.DataFrame:
    """Per game and side, offense only, from cfbfastR play-by-play: EPA per play (all, rushing, passing), success
    rate and explosive-play rate (20+ yards). Garbage time is left out (second half with a lead of 28+, or fourth
    quarter with 22+), when starters sit and the numbers stop meaning much."""
    import pyarrow.parquet as pq  # noqa: PLC0415

    names = set(pq.read_schema(path).names)
    d = pd.read_parquet(path, columns=[c for c in PBP_COLS if c in names])
    d = d[(d.rush.fillna(0) == 1) | (d["pass"].fillna(0) == 1)]
    d = d[d.EPA.notna()]
    lead = (d.pos_team_score - d.def_pos_team_score).abs()
    d = d[~(((d.period >= 3) & (lead >= 28)) | ((d.period >= 4) & (lead >= 22)))]
    d = d.assign(side=np.where(d.pos_team == d.home, "home", "away"),
                 explosive=(d.yards_gained >= 20).astype(float),
                 epa_rush=d.EPA.where(d.rush == 1), epa_pass=d.EPA.where(d["pass"] == 1))
    a = d.groupby(["game_id", "side"]).agg(epa=("EPA", "mean"), sr=("success", "mean"), expl=("explosive", "mean"),
                                           epa_rush=("epa_rush", "mean"), epa_pass=("epa_pass", "mean"),
                                           pbp_plays=("EPA", "size"))
    a = a[a.pbp_plays >= 25].unstack("side")
    a.columns = [f"{side}_{m}" for m, side in a.columns]
    a = a.reset_index()
    a["game_id"] = a.game_id.astype("int64")
    return a


def load_pbp_stats(first: int = sources.FIRST_SEASON, last: int = sources.CURRENT_SEASON) -> pd.DataFrame:
    """Saved per-game efficiency (written by the collector from each season's play-by-play)."""
    frames = []
    for yr in range(first, last + 1):
        p = sources.raw_dir() / sources.local_name("pbp_stats", yr)
        if p.exists():
            frames.append(pd.read_csv(p))
    return pd.concat(frames, ignore_index=True).drop_duplicates("game_id") if frames else pd.DataFrame(columns=["game_id"])
