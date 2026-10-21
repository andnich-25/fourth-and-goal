"""Point-in-time (pregame) feature builder.

For a target (season, week, player, team) every feature is computed from games dated
strictly before that week. Defense and team context are recomputed at each week's own
cutoff (no "as of the latest import" tables leak into historical rows).
"""
from __future__ import annotations

import math
import sqlite3
from collections import defaultdict, deque

import numpy as np
import pandas as pd

WINDOW = 8  # most recent participated games carried in the player window
PRIOR_SEASON_WEIGHT = 0.5  # games from last season count half
DEF_SHRINK_GAMES = 4.0
TEAM_SHRINK_GAMES = 3.0
RATE_SHRINK_GAMES = 4.0
POSITIONS = ("QB", "RB", "WR", "TE")

FEATURE_DOC = {
    "n_games_cur": "Participated games this season before the target week",
    "n_games_window": "Participated games in the recency window (last 8, last season at half weight)",
    "carries_pg": "Carries per game (weighted window)",
    "targets_pg": "Targets per game (weighted window)",
    "rz_carries_pg": "Carries from inside the 20 per game",
    "goal10_carries_pg": "Carries from inside the 10 per game",
    "goal5_carries_pg": "Carries from inside the 5 per game",
    "rz_targets_pg": "Targets with the line of scrimmage inside the 20 per game",
    "goal10_targets_pg": "Targets with the line of scrimmage inside the 10 per game",
    "ez_proxy_pg": "End-zone target proxy per game (air yards >= yards to goal; not charted)",
    "xtd_pg": "Play-based xTD per game (historical conversion of the player's opportunities)",
    "td_pg": "Rushing + receiving TDs per game",
    "snap_pct": "Average offensive snap share (when snap counts are imported)",
    "xtd_share": "Player share of team xTD in the games he played",
    "opp_share": "Player share of team carries + targets in the games he played",
    "anytime_rate_shrunk": "Share of games with a TD, shrunk toward the position rate",
    "team_implied_total": "Market-implied team points for the target game (schedule spread/total)",
    "team_td_pg": "Team offensive rush+rec TDs per game this season before the week (shrunk)",
    "opp_def_pos_td_pg": "Opponent TDs allowed to this position per game, prior games only (shrunk)",
    "opp_def_pos_mult": "Opponent position TDs allowed relative to league average (prior games only)",
    "opp_def_pos_xtd_mult": "Opponent position xTD allowed relative to league average",
    "opp_def_games": "Opponent games in the defensive sample",
    "changed_team": "Most recent game was for a different team",
    "missed_team_games": "Team games this season the player did not participate in",
}


def _df(c, sql, params=()):
    return pd.read_sql_query(sql, c, params=params)


def _league_position_rates(hist: pd.DataFrame) -> dict:
    out = {}
    for pos, g in hist.groupby("position"):
        out[pos] = {"anytime": g.scored_anytime.mean(), "td_pg": g.anytime_tds.mean()}
    return out


def build_targets(c: sqlite3.Connection, seasons: list[int], extra_weeks: list[tuple[int, int]] | None = None) -> pd.DataFrame:
    """Target rows = participated player-games plus pregame roster rows (ACT) for each week with games.

    extra_weeks: upcoming (season, week) pairs to score from rosters even with no results yet.
    """
    ph = ",".join("?" * len(seasons))
    played = _df(c, f"SELECT season, week, game_id, player_id, player_name, position, team, opponent, participated, "
                    f"scored_anytime, anytime_tds FROM player_game WHERE season IN ({ph}) AND participated=1 "
                    f"AND position IN ('QB','RB','WR','TE')", seasons)
    played["on_roster_act"] = np.nan
    weeks = _df(c, f"SELECT DISTINCT season, week FROM games WHERE season IN ({ph})", seasons)
    pairs = set(map(tuple, weeks.values.tolist())) | set(extra_weeks or [])
    ros = _df(c, f"SELECT season, week, player_id, player_name, position, team, status FROM roster_week "
                 f"WHERE season IN ({ph}) AND position IN ('QB','RB','WR','TE')", sorted({s for s, _ in pairs}) or seasons)
    ros = ros[[(s, w) in pairs for s, w in zip(ros.season, ros.week)]] if len(ros) else ros
    ros["on_roster_act"] = (ros.status == "ACT").astype(float)
    # Merge: keep participated rows, attach roster status; add roster-only rows as non-participants.
    keys = ["season", "week", "player_id", "team"]
    t = played.merge(ros[keys + ["status", "on_roster_act"]], on=keys, how="left", suffixes=("", "_r"))
    t["on_roster_act"] = t.on_roster_act_r
    t = t.drop(columns=["on_roster_act_r"])
    only = ros.merge(played[keys], on=keys, how="left", indicator=True)
    only = only[only._merge == "left_only"].drop(columns=["_merge"])
    only["participated"] = 0
    only["scored_anytime"] = np.nan
    only["anytime_tds"] = np.nan
    t = pd.concat([t, only], ignore_index=True)
    # Attach game id/opponent/home from the schedule for the team's game that week.
    g = _df(c, f"SELECT game_id, season, week, home_team, away_team, gameday, gametime, spread_line, total_line, "
               f"home_score FROM games WHERE season IN ({ph})", seasons)
    home = g.rename(columns={"home_team": "team", "away_team": "s_opp"}).assign(is_home=1)
    away = g.rename(columns={"away_team": "team", "home_team": "s_opp"}).assign(is_home=0)
    sched = pd.concat([home, away])
    sched["implied_total"] = np.where(sched.is_home == 1, (sched.total_line + sched.spread_line) / 2,
                                      (sched.total_line - sched.spread_line) / 2)
    sched = sched.rename(columns={"game_id": "s_game"})[["season", "week", "team", "s_game", "s_opp", "is_home", "gameday",
                                                          "gametime", "implied_total", "home_score"]]
    t = t.merge(sched, on=["season", "week", "team"], how="left")
    t["game_id"] = t.game_id.fillna(t.s_game) if "game_id" in t else t.s_game
    t["opponent"] = t.opponent.fillna(t.s_opp)
    t["game_completed"] = t.home_score.notna().astype(int)
    # Teams on bye have no game: drop those roster rows.
    t = t[t.game_id.notna()]
    return t.drop(columns=["s_game", "s_opp", "home_score"]).reset_index(drop=True)


def compute_features(c: sqlite3.Connection, targets: pd.DataFrame, injuries: bool = True) -> pd.DataFrame:
    hist = _df(c, "SELECT * FROM player_game WHERE participated=1 AND position IN ('QB','RB','WR','TE','FB')")
    team = _df(c, "SELECT season, week, team, opponent, offensive_tds, xtd, opportunities FROM team_game")
    team_opp = _df(c, "SELECT season, week, team, SUM(carries + targets) AS team_touch_opps FROM player_game GROUP BY 1,2,3")
    hist = hist.merge(team.rename(columns={"xtd": "team_xtd", "opportunities": "team_ev_opps"})[["season", "week", "team", "team_xtd"]],
                      on=["season", "week", "team"], how="left").merge(team_opp, on=["season", "week", "team"], how="left")
    hist = hist.sort_values(["season", "week"])
    pos_rates = _league_position_rates(hist[hist.season >= hist.season.max() - 2])

    # ---- player windows (one chronological pass per player) ----
    by_player = defaultdict(list)
    for r in hist.itertuples(index=False):
        by_player[r.player_id].append(r)
    tgt = targets.sort_values(["season", "week"]).reset_index()
    feats = {}
    stat_cols = ["carries", "targets", "rz_carries", "goal10_carries", "goal5_carries", "rz_targets", "goal10_targets",
                 "ez_target_proxy", "anytime_tds"]
    for pid, rows in tgt.groupby("player_id"):
        games = by_player.get(pid, [])
        gi = 0
        window: deque = deque(maxlen=WINDOW)
        season_games: dict = defaultdict(int)
        season_tds: dict = defaultdict(int)
        season_xtd: dict = defaultdict(float)
        for r in rows.itertuples(index=False):
            while gi < len(games) and (games[gi].season, games[gi].week) < (r.season, r.week):
                window.append(games[gi])
                g = games[gi]
                season_games[g.season] += 1
                season_tds[g.season] += int(g.anytime_tds or 0)
                season_xtd[g.season] += 0.0 if _nan(g.xtd) else float(g.xtd)
                gi += 1
            feats[r.index] = _player_features(window, r, pos_rates)
            # Season-to-date count is not capped by the recency window.
            feats[r.index]["n_games_cur"] = season_games.get(r.season, 0)
            feats[r.index]["cur_tds"] = season_tds.get(r.season, 0)
            feats[r.index]["cur_xtd"] = season_xtd.get(r.season, 0.0)
    pf = pd.DataFrame.from_dict(feats, orient="index")
    out = tgt.set_index("index").join(pf)

    # ---- team context at each week's cutoff ----
    out = out.join(_team_features(team, out), how="left")
    out = out.join(_defense_features(c, out), how="left")
    out["team_implied_total"] = out.pop("implied_total")
    out["missed_team_games"] = (out.team_games_cur - out.n_games_cur).clip(lower=0)
    if injuries:
        inj = _df(c, "SELECT season, week, team, player_id, report_status, practice_status, injury FROM injuries")
        out = out.reset_index().merge(inj, on=["season", "week", "team", "player_id"], how="left").set_index("index")
        published = inj.groupby(["season", "week", "team"]).size().rename("inj_rows").reset_index()
        out = out.reset_index().merge(published, on=["season", "week", "team"], how="left").set_index("index")
        out["injury_report_published"] = out.inj_rows.notna().astype(int)
        out = out.drop(columns=["inj_rows"])
    return out.sort_index()


def _player_features(window, r, pos_rates) -> dict:
    pos = r.position if r.position in pos_rates else "WR"
    base_any = pos_rates.get(pos, {"anytime": 0.15})["anytime"]
    if not window:
        return {"n_games_cur": 0, "n_games_window": 0, "has_history": 0, "anytime_rate_shrunk": base_any,
                "changed_team": 0, "last_game_week": None, "last_game_season": None}
    w = np.array([1.0 if g.season == r.season else PRIOR_SEASON_WEIGHT for g in window])
    ws = w.sum()

    def wmean(attr):
        return float(sum(wi * (getattr(g, attr) or 0) for wi, g in zip(w, window)) / ws)

    xtd_vals = [(wi, g.xtd, g.team_xtd) for wi, g in zip(w, window) if g.xtd is not None and not _nan(g.xtd) and g.team_xtd and not _nan(g.team_xtd)]
    xtd_share = (sum(wi * x for wi, x, _ in xtd_vals) / sum(wi * tx for wi, _, tx in xtd_vals)) if xtd_vals else None
    xtd_pg = (sum(wi * x for wi, x, _ in xtd_vals) / sum(wi for wi, _, _ in xtd_vals)) if xtd_vals else None
    opp_vals = [(wi, (g.carries or 0) + (g.targets or 0), g.team_touch_opps) for wi, g in zip(w, window) if g.team_touch_opps]
    opp_share = (sum(wi * o for wi, o, _ in opp_vals) / sum(wi * t for wi, _, t in opp_vals)) if opp_vals else None
    snaps = [(wi, g.offense_pct) for wi, g in zip(w, window) if g.offense_pct is not None and not _nan(g.offense_pct)]
    scored = sum(wi * (g.scored_anytime or 0) for wi, g in zip(w, window))
    last = window[-1]
    return {
        "n_games_window": len(window), "has_history": 1, "eff_games": ws,
        "carries_pg": wmean("carries"), "targets_pg": wmean("targets"), "rz_carries_pg": wmean("rz_carries"),
        "goal10_carries_pg": wmean("goal10_carries"), "goal5_carries_pg": wmean("goal5_carries"),
        "rz_targets_pg": wmean("rz_targets"), "goal10_targets_pg": wmean("goal10_targets"),
        "ez_proxy_pg": wmean("ez_target_proxy"), "td_pg": wmean("anytime_tds"), "xtd_pg": xtd_pg,
        "xtd_share": xtd_share, "opp_share": opp_share,
        "snap_pct": (sum(wi * s for wi, s in snaps) / sum(wi for wi, _ in snaps)) if snaps else None,
        "anytime_rate_shrunk": (scored + RATE_SHRINK_GAMES * base_any) / (ws + RATE_SHRINK_GAMES),
        "changed_team": int(last.team != r.team), "last_game_week": int(last.week), "last_game_season": int(last.season),
    }


def _nan(x) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


def _team_features(team: pd.DataFrame, out: pd.DataFrame) -> pd.DataFrame:
    """Season-to-date team offense before each target week, shrunk toward the league mean."""
    res = {}
    keys = out[["season", "week", "team"]].drop_duplicates()
    tg = team.groupby(["season", "team"])
    league = team.groupby("season").offensive_tds.mean().to_dict()
    for s, wk, tm in keys.itertuples(index=False):
        prior = tg.get_group((s, tm)) if (s, tm) in tg.groups else team.iloc[0:0]
        prior = prior[prior.week < wk]
        n = len(prior)
        prev_league = league.get(s - 1, league.get(s, 2.4))
        lg = team[(team.season == s) & (team.week < wk)].offensive_tds.mean() if n else prev_league
        lg = prev_league if _nan(lg) else lg
        res[(s, wk, tm)] = {"team_games_cur": n,
                            "team_td_pg": (prior.offensive_tds.sum() + TEAM_SHRINK_GAMES * lg) / (n + TEAM_SHRINK_GAMES),
                            "league_team_td_pg": lg}
    tf = pd.DataFrame.from_dict(res, orient="index")
    tf.index = pd.MultiIndex.from_tuples(tf.index, names=["season", "week", "team"])
    return out[["season", "week", "team"]].join(tf, on=["season", "week", "team"]).drop(columns=["season", "week", "team"])


def defense_table(c: sqlite3.Connection, season: int, week: int, window: int | None = None) -> pd.DataFrame:
    """Per defense x position allowed, using only completed games before `week` (optionally last N)."""
    d = _df(c, "SELECT * FROM def_pos_game WHERE season=? AND week<?", (season, week))
    if d.empty:
        return d
    gp = d[["defense", "week"]].drop_duplicates()
    if window:
        gp = gp.sort_values("week", ascending=False).groupby("defense").head(window)
        d = d.merge(gp, on=["defense", "week"])
    games = gp.groupby("defense").week.nunique().rename("games")
    agg = d.groupby(["defense", "position"]).sum(numeric_only=True).drop(columns=["season", "week"], errors="ignore")
    agg = agg.join(games, on="defense").reset_index()
    return agg


def _defense_features(c, out: pd.DataFrame) -> pd.DataFrame:
    res = {}
    cache = {}
    for s, wk in out[["season", "week"]].drop_duplicates().itertuples(index=False):
        t = defense_table(c, int(s), int(wk))
        if t.empty:
            continue
        t = t[t.position.isin(POSITIONS)]
        all_games = t.groupby("defense").games.first()
        league = t.groupby("position")[["touchdowns", "xtd"]].sum()
        total_games = all_games.sum()
        cache[(s, wk)] = (t.set_index(["defense", "position"]), league, total_games, all_games)
    for idx, s, wk, opp, pos in out[["season", "week", "opponent", "position"]].itertuples():
        if (s, wk) not in cache or pos not in POSITIONS:
            continue
        t, league, total_games, all_games = cache[(s, wk)]
        lg_td = league.touchdowns.get(pos, 0) / total_games if total_games else None
        lg_xtd = league.xtd.get(pos, 0) / total_games if total_games else None
        games = float(all_games.get(opp, 0))
        row = t.loc[(opp, pos)] if (opp, pos) in t.index else None
        tds = float(row.touchdowns) if row is not None else 0.0
        xtd = float(row.xtd) if row is not None and not _nan(row.xtd) else 0.0
        if not lg_td:
            continue
        shr = (tds + DEF_SHRINK_GAMES * lg_td) / (games + DEF_SHRINK_GAMES)
        shr_x = (xtd + DEF_SHRINK_GAMES * lg_xtd) / (games + DEF_SHRINK_GAMES) if lg_xtd else None
        res[idx] = {"opp_def_games": games, "opp_def_pos_tds": tds, "opp_def_pos_td_pg": shr,
                    "opp_def_pos_td_pg_raw": tds / games if games else None,
                    "league_pos_td_pg": lg_td, "opp_def_pos_mult": shr / lg_td,
                    "opp_def_pos_xtd_mult": (shr_x / lg_xtd) if shr_x and lg_xtd else None}
    return pd.DataFrame.from_dict(res, orient="index")
