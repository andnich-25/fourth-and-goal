"""Which tendencies repeat, across every completed season in the database.

A tendency is only useful for prediction if it repeats. Two checks, per metric:
  * odd vs even weeks of the same season (does the tendency show up in both halves of the schedule?)
  * one season vs the next for the same player, team or defense (does it carry over?)
Both are plain correlations across entities. A metric that repeats strongly is a real trait; one near zero is
mostly luck, however striking it looks in a small sample. Situational tables show touchdown rates by game
context over the same seasons. Everything here describes completed games; nothing is tuned to these numbers.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .backtest import wilson

STRONG, SOME = 0.5, 0.25
MIN_HALF_GAMES = 3
MIN_SEASON_GAMES = 8

# metric -> (label, numerator, denominator or None for per game, used by the TD model?)
PLAYER = {
    "td_rate": ("Scores a TD (share of games)", "scored_anytime", None, True),
    "rz_opps": ("Red-zone carries + targets per game", "rz_opps", None, True),
    "goal10_opps": ("Inside-10 carries + targets per game", "goal10_opps", None, True),
    "xtd": ("Expected TDs (xTD) per game", "xtd", None, True),
    "targets": ("Targets per game", "targets", None, False),
    "carries": ("Carries per game", "carries", None, False),
    "snap": ("Offensive snap share", "offense_pct", None, True),
    "finishing": ("TDs above expectation (TDs minus xTD) per game", "td_minus_xtd", None, False),
}
TEAM = {
    "off_tds": ("Offensive TDs per game", "offensive_tds", None, True),
    "rz_trips": ("Red-zone trips per game", "rz_trips", None, True),
    "rz_td_rate": ("Red-zone trips ending in a TD", "rz_td_drives", "rz_trips", True),
    "plays": ("Offensive plays per game (pace)", "plays", None, False),
    "xtd": ("Team xTD per game", "xtd", None, True),
}
DEFENSE = {
    "tds_allowed": ("Rush + rec TDs allowed per game", "touchdowns", None, True),
    "xtd_allowed": ("xTD allowed per game", "xtd", None, True),
    "rz_td_rate_allowed": ("Opponent red-zone trips ending in a TD", "rz_td_drives", "rz_trips", True),
    "rb_tds": ("TDs allowed to RBs per game", "RB", None, True),
    "wr_tds": ("TDs allowed to WRs per game", "WR", None, True),
    "te_tds": ("TDs allowed to TEs per game", "TE", None, True),
}


def _verdict(r: float | None) -> str:
    if r is None or np.isnan(r):
        return "Not enough data"
    return "Repeats strongly" if r >= STRONG else "Some signal" if r >= SOME else "Mostly noise"


def _agg(df: pd.DataFrame, keys: list[str], num: str, den: str | None, min_games: int) -> pd.DataFrame:
    g = df.groupby(keys).agg(n=("week", "size"), num=(num, "sum"), **({"den": (den, "sum")} if den else {})).reset_index()
    g = g[g.n >= min_games]
    g["v"] = g.num / (g.den.replace(0, np.nan) if den else g.n)
    return g.dropna(subset=["v"])


def _repeat(df: pd.DataFrame, entity: str, num: str, den: str | None) -> dict:
    d = df.assign(half=np.where(df.week % 2 == 1, "odd", "even"))
    h = _agg(d, [entity, "season", "half"], num, den, MIN_HALF_GAMES).pivot_table(index=[entity, "season"], columns="half", values="v").dropna()
    s = _agg(df, [entity, "season"], num, den, MIN_SEASON_GAMES)
    nxt = s.merge(s.assign(season=s.season - 1), on=[entity, "season"], suffixes=("", "_next"))
    r_half = float(h.odd.corr(h.even)) if len(h) > 20 else None
    r_next = float(nxt.v.corr(nxt.v_next)) if len(nxt) > 20 else None
    vals = [r for r in (r_half, r_next) if r is not None]
    return {"r_half": r_half, "n_half": int(len(h)), "r_next": r_next, "n_next": int(len(nxt)),
            "verdict": _verdict(float(np.mean(vals)) if vals else None)}


def build(c, first: int, last: int) -> dict:
    """Tendency stability and situational TD rates over completed seasons first..last."""
    pg = pd.read_sql_query(
        "SELECT season, week, game_id, player_id, position, team, opponent, scored_anytime, anytime_tds, xtd, targets, carries, "
        "offense_pct, rz_carries + rz_targets AS rz_opps, goal10_carries + goal10_targets AS goal10_opps FROM player_game "
        "WHERE participated=1 AND position IN ('QB','RB','WR','TE') AND season BETWEEN ? AND ?", c, params=(first, last))
    pg["td_minus_xtd"] = pg.anytime_tds - pg.xtd
    tg = pd.read_sql_query("SELECT * FROM team_game WHERE season BETWEEN ? AND ?", c, params=(first, last))
    dp = pd.read_sql_query("SELECT season, week, defense, position, touchdowns, xtd FROM def_pos_game WHERE season BETWEEN ? AND ?", c,
                           params=(first, last))
    if pg.empty:
        return {"seasons": [], "tendencies": [], "situations": [], "empty_reason": "No completed seasons imported."}

    out = []
    # Players: skill-position regulars only (a snap share filter would drop seasons without snap data).
    for pos in ("RB", "WR", "TE"):
        d = pg[pg.position == pos]
        for key, (label, num, den, used) in PLAYER.items():
            if d[num].notna().sum() < 500:
                continue
            out.append({"group": f"{pos}s", "metric": key, "label": label, "in_model": used,
                        **_repeat(d.dropna(subset=[num]), "player_id", num, den)})
    for key, (label, num, den, used) in TEAM.items():
        out.append({"group": "Offenses", "metric": key, "label": label, "in_model": used, **_repeat(tg, "team", num, den)})
    allowed = dp.groupby(["season", "week", "defense"]).agg(touchdowns=("touchdowns", "sum"), xtd=("xtd", "sum")).reset_index()
    by_pos = dp.pivot_table(index=["season", "week", "defense"], columns="position", values="touchdowns", aggfunc="sum").reset_index()
    opp = tg.rename(columns={"opponent": "defense"})[["season", "week", "defense", "rz_trips", "rz_td_drives"]]
    dd = allowed.merge(by_pos, on=["season", "week", "defense"], how="left").merge(opp, on=["season", "week", "defense"], how="left")
    for key, (label, num, den, used) in DEFENSE.items():
        if num not in dd:
            continue
        out.append({"group": "Defenses", "metric": key, "label": label, "in_model": used,
                    **_repeat(dd.dropna(subset=[num]), "defense", num, den)})

    # Situations: TD rate by game context, per position (players who scored or had a red-zone chance at least once that season).
    g = pd.read_sql_query("SELECT game_id, home_team, away_team, spread_line, total_line, roof FROM games WHERE season BETWEEN ? AND ?", c,
                          params=(first, last))
    x = pg.merge(g, on="game_id", how="left")
    home = x.team == x.home_team
    x["is_home"] = home
    sign = np.where(home, 1, -1)
    x["implied"] = (x.total_line + sign * x.spread_line) / 2
    x["favored"] = sign * x.spread_line > 0
    active = x.groupby(["season", "player_id"]).rz_opps.transform("sum") > 0
    x = x[active]
    sits = []

    def table(factor, label, col, buckets):
        rows = []
        for name, mask in buckets:
            r = {"bucket": name}
            for pos in ("RB", "WR", "TE"):
                m = mask & (x.position == pos) & x.scored_anytime.notna()
                n, k = int(m.sum()), int(x.loc[m, "scored_anytime"].sum())
                r[pos] = {"n": n, "rate": k / n if n else None, "ci": wilson(k, n)}
            rows.append(r)
        sits.append({"factor": factor, "label": label, "rows": rows})

    imp = x.implied
    table("implied", "Team's implied points (from the betting line)", "implied",
          [("Under 20", imp < 20), ("20–23.5", (imp >= 20) & (imp < 24)), ("24–26.5", (imp >= 24) & (imp < 27)), ("27+", imp >= 27)])
    table("home", "Home or away", "is_home", [("Home", x.is_home), ("Away", ~x.is_home)])
    table("favored", "Favored or underdog", "favored", [("Favored", x.favored), ("Underdog", ~x.favored & x.spread_line.notna())])
    table("roof", "Stadium", "roof", [("Dome / closed roof", x.roof.isin(["dome", "closed"])), ("Outdoors / open", x.roof.isin(["outdoors", "open"]))])
    return {"seasons": [first, last], "player_games": int(len(pg)), "tendencies": out, "situations": sits,
            "thresholds": {"strong": STRONG, "some": SOME},
            "notes": ["Odd vs even weeks: correlation between a player's (or team's) numbers in odd weeks and in even weeks of the same season, "
                      f"for those with at least {MIN_HALF_GAMES} games in each half.",
                      f"Season to season: correlation between one season and the next, for those with at least {MIN_SEASON_GAMES} games in both.",
                      "Situational rates cover players who had at least one red-zone chance that season; ranges are 95% intervals."]}
