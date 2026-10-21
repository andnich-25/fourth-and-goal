"""Derived tables: play xTD, player-game ledger, team-game context, defense-by-position.

Everything here is retrospective (what happened). Forward-looking features are built
in `features.py` strictly from rows dated before the prediction week.
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict

import numpy as np
import pandas as pd

PRIOR_WEIGHT = 40  # pseudo-observations shrinking a bucket toward its run/pass family rate
MIN_TRAIN_EVENTS_PRODUCTION = 50_000  # handoff gate for the current-season board
MIN_TRAIN_EVENTS_BACKFILL = 25_000  # one full season; used only to score earlier seasons for training rows
POSITIONS = ("QB", "RB", "WR", "TE")


def bucket(d: float) -> str:
    if d <= 2:
        return "01-02"
    if d <= 5:
        return "03-05"
    if d <= 10:
        return "06-10"
    if d <= 20:
        return "11-20"
    if d <= 40:
        return "21-40"
    return "41-99"


def category(event_type: str, d: float, air) -> tuple[str, str, str]:
    if event_type == "pass":
        ez = air is not None and not (isinstance(air, float) and np.isnan(air)) and air >= d
        return ("pass", bucket(d), "EZ_PROXY" if ez else "NON_EZ")
    return ("run", bucket(d), "CARRY")


def build_xtd(c: sqlite3.Connection, log=print) -> dict:
    """Score each season's events with conversion rates learned only from earlier seasons."""
    seasons = [r[0] for r in c.execute("SELECT DISTINCT season FROM pbp_events ORDER BY season")]
    report = {}
    with c:
        c.execute("DELETE FROM xtd_rates")
        c.execute("UPDATE pbp_events SET xtd=NULL")
        for s in seasons:
            train = [x for x in seasons if x < s]
            if not train:
                report[s] = {"scored": False, "reason": "no earlier season to learn conversion rates from"}
                continue
            q = c.execute(f"SELECT event_type, yards_to_goal, air_yards, td FROM pbp_events WHERE season IN ({','.join('?'*len(train))})", train)
            rates = defaultdict(lambda: [0, 0])
            fam = defaultdict(lambda: [0, 0])
            total = 0
            for t, d, a, td in q:
                k = category(t, d, a)
                rates[k][0] += td
                rates[k][1] += 1
                fam[t][0] += td
                fam[t][1] += 1
                total += 1
            if total < MIN_TRAIN_EVENTS_BACKFILL:
                report[s] = {"scored": False, "reason": f"only {total:,} earlier events"}
                continue
            est = {}
            for k, (tds, n) in rates.items():
                fs, fn = fam[k[0]]
                p0 = fs / fn if fn else 0.03
                est[k] = (tds + PRIOR_WEIGHT * p0) / (n + PRIOR_WEIGHT)
                c.execute("INSERT INTO xtd_rates VALUES (?,?,?,?,?,?,?,?)",
                          (s, k[0], k[1], k[2], tds, n, round(est[k], 6), ",".join(map(str, train))))
            rows = c.execute("SELECT rowid, event_type, yards_to_goal, air_yards FROM pbp_events WHERE season=?", (s,)).fetchall()
            c.executemany("UPDATE pbp_events SET xtd=? WHERE rowid=?",
                          [(round(est.get(category(t, d, a), 0.0), 6), rid) for rid, t, d, a in rows])
            report[s] = {"scored": True, "train_seasons": train, "train_events": total,
                         "meets_production_gate": total >= MIN_TRAIN_EVENTS_PRODUCTION}
            log(f"xTD season {s}: trained on {train} ({total:,} events), scored {len(rows):,} events")
    return report


def _read(c, sql, params=()):
    return pd.read_sql_query(sql, c, params=params)


def build_player_game(c: sqlite3.Connection, log=print) -> int:
    ev = _read(c, "SELECT season, week, game_id, offense AS team, defense AS opponent, event_type, player_id, player_name, "
                  "position AS ev_pos, yards_to_goal AS d, ez_proxy, td, xtd FROM pbp_events")
    stats = _read(c, "SELECT season, week, game_id, player_id, player_name, position, team, opponent, carries, targets, "
                     "receptions, rush_tds, rec_tds FROM player_week")
    roster = _read(c, "SELECT season, week, player_id, player_name, position, team, pfr_id FROM roster_week")
    snaps = _read(c, "SELECT season, week, game_id, team, pfr_player_id, player_name, position, offense_snaps, offense_pct FROM snaps")
    games = _read(c, "SELECT game_id, season, week, home_team, away_team FROM games")

    # Event aggregates per player-game. Misses are opportunities, never "drops".
    if not ev.empty:
        run, pas = ev.event_type.eq("run"), ev.event_type.eq("pass")
        ev = ev.assign(
            goal5_carries=(run & (ev.d <= 5)).astype(int), goal10_carries=(run & (ev.d <= 10)).astype(int),
            rz_carries=(run & (ev.d <= 20)).astype(int), goal5_targets=(pas & (ev.d <= 5)).astype(int),
            goal10_targets=(pas & (ev.d <= 10)).astype(int), rz_targets=(pas & (ev.d <= 20)).astype(int),
            ez_target_proxy=(pas & ev.ez_proxy.eq(1)).astype(int),
            missed_rz_targets=(pas & (ev.d <= 20) & ev.td.eq(0)).astype(int),
            missed_goal5_carries=(run & (ev.d <= 5) & ev.td.eq(0)).astype(int),
            ev_rush_td=(run & ev.td.eq(1)).astype(int), ev_rec_td=(pas & ev.td.eq(1)).astype(int),
            ev_carries=run.astype(int), ev_targets=pas.astype(int), opportunities=1)
        cols = ["goal5_carries", "goal10_carries", "rz_carries", "goal5_targets", "goal10_targets", "rz_targets",
                "ez_target_proxy", "missed_rz_targets", "missed_goal5_carries", "ev_rush_td", "ev_rec_td",
                "ev_carries", "ev_targets", "opportunities"]
        agg = ev.groupby(["season", "week", "player_id", "team"], as_index=False).agg(
            game_id=("game_id", "first"), opponent=("opponent", "first"), ev_name=("player_name", "first"),
            ev_pos=("ev_pos", "first"), xtd=("xtd", lambda s: s.sum(min_count=1)), **{k: (k, "sum") for k in cols})
    else:
        agg = pd.DataFrame(columns=["season", "week", "player_id", "team"])

    # Snap counts are keyed by PFR id; map them to gsis ids through that season's roster.
    pfr = roster.dropna(subset=["pfr_id"]).query("pfr_id != ''").drop_duplicates(["season", "pfr_id"])[["season", "pfr_id", "player_id"]]
    sn = snaps.merge(pfr, left_on=["season", "pfr_player_id"], right_on=["season", "pfr_id"], how="inner")
    sn = sn.groupby(["season", "week", "player_id", "team"], as_index=False).agg(
        sn_game=("game_id", "first"), sn_name=("player_name", "first"), sn_pos=("position", "first"),
        offense_snaps=("offense_snaps", "sum"), offense_pct=("offense_pct", "max"))

    st = stats.rename(columns={"game_id": "st_game", "player_name": "st_name", "position": "st_pos", "opponent": "st_opp"})
    st["has_box"] = 1
    keys = ["season", "week", "player_id", "team"]
    pg = st.merge(agg, on=keys, how="outer").merge(sn, on=keys, how="outer")

    # Position crosswalk: box score, then roster, then the PBP-listed position.
    ros_pos = roster.drop_duplicates(["season", "player_id"], keep="last").set_index(["season", "player_id"])["position"]
    ros_name = roster.drop_duplicates(["season", "player_id"], keep="last").set_index(["season", "player_id"])["player_name"]
    idx = pd.MultiIndex.from_frame(pg[["season", "player_id"]])
    pg["position"] = pg.st_pos.fillna(pd.Series(ros_pos.reindex(idx).values, index=pg.index)).fillna(pg.get("ev_pos")).fillna(pg.get("sn_pos"))
    pg["player_name"] = pg.st_name.fillna(pd.Series(ros_name.reindex(idx).values, index=pg.index)).fillna(pg.get("ev_name")).fillna(pg.get("sn_name"))
    pg["game_id"] = pg.st_game.replace("", np.nan).fillna(pg.get("game_id")).fillna(pg.get("sn_game"))

    # Opponent: box score, then PBP, then schedule.
    opp = pg.st_opp.replace("", np.nan).fillna(pg.get("opponent"))
    if not games.empty:
        gh = games.set_index("game_id")
        sched_opp = pg.apply(lambda r: (gh.at[r.game_id, "away_team"] if gh.at[r.game_id, "home_team"] == r.team else gh.at[r.game_id, "home_team"])
                             if isinstance(r.game_id, str) and r.game_id in gh.index else np.nan, axis=1) if len(pg) else pd.Series(dtype=object)
        opp = opp.fillna(sched_opp)
    pg["opponent"] = opp

    for col in ["has_box", "offense_snaps", "opportunities", "goal5_carries", "goal10_carries", "rz_carries", "goal5_targets",
                "goal10_targets", "rz_targets", "ez_target_proxy", "missed_rz_targets", "missed_goal5_carries",
                "ev_rush_td", "ev_rec_td", "ev_carries", "ev_targets"]:
        if col not in pg:
            pg[col] = 0
        pg[col] = pg[col].fillna(0).astype(int)
    # Box score is authoritative for carries/targets/TDs; PBP fills gaps when a box row is missing.
    pg["carries"] = pg.carries.where(pg.has_box.eq(1), pg.ev_carries).fillna(0).astype(int)
    pg["targets"] = pg.targets.where(pg.has_box.eq(1), pg.ev_targets).fillna(0).astype(int)
    pg["receptions"] = pg.receptions.fillna(0).astype(int)
    pg["rush_tds"] = pg.rush_tds.where(pg.has_box.eq(1), pg.ev_rush_td).fillna(0).astype(int)
    pg["rec_tds"] = pg.rec_tds.where(pg.has_box.eq(1), pg.ev_rec_td).fillna(0).astype(int)
    pg["anytime_tds"] = pg.rush_tds + pg.rec_tds  # passing TDs never count
    pg["scored_anytime"] = (pg.anytime_tds > 0).astype(int)
    pg["participated"] = ((pg.has_box == 1) | (pg.offense_snaps > 0) | (pg.opportunities > 0)).astype(int)
    pg = pg[pg.position.isin(("QB", "RB", "WR", "TE", "FB"))]

    out_cols = ["season", "week", "game_id", "player_id", "player_name", "position", "team", "opponent", "participated",
                "has_box", "offense_snaps", "offense_pct", "carries", "targets", "receptions", "rush_tds", "rec_tds",
                "anytime_tds", "scored_anytime", "goal5_carries", "goal10_carries", "rz_carries", "goal5_targets",
                "goal10_targets", "rz_targets", "ez_target_proxy", "missed_rz_targets", "missed_goal5_carries", "xtd",
                "opportunities"]
    pg = pg[out_cols]
    rows = [tuple(None if (isinstance(v, float) and np.isnan(v)) else (v.item() if hasattr(v, "item") else v) for v in r)
            for r in pg.itertuples(index=False, name=None)]
    with c:
        c.execute("DELETE FROM player_game")
        c.executemany(f"INSERT OR REPLACE INTO player_game VALUES ({','.join('?'*len(out_cols))})", rows)
    log(f"player_game: {len(rows):,} player-games")
    return len(rows)


def build_team_and_defense(c: sqlite3.Connection, log=print) -> dict:
    with c:
        c.execute("DELETE FROM team_game")
        c.execute("DELETE FROM def_pos_game")
        # Team offense per game. Offensive TDs = rushing + receiving TDs credited in PBP.
        c.execute("""
        INSERT INTO team_game
        SELECT e.season, e.week, e.game_id, e.offense, e.defense,
               CASE WHEN g.home_team = e.offense THEN 1 WHEN g.home_team IS NULL THEN NULL ELSE 0 END,
               CASE WHEN g.home_team = e.offense THEN g.home_score WHEN g.away_team = e.offense THEN g.away_score END,
               SUM(e.td), SUM(CASE WHEN e.event_type='run' THEN e.td ELSE 0 END),
               SUM(CASE WHEN e.event_type='pass' THEN e.td ELSE 0 END), SUM(e.xtd), COUNT(*),
               tp.plays, tp.seconds,
               (SELECT COUNT(*) FROM drives d WHERE d.season=e.season AND d.game_id=e.game_id AND d.offense=e.offense),
               (SELECT SUM(inside20) FROM drives d WHERE d.season=e.season AND d.game_id=e.game_id AND d.offense=e.offense),
               (SELECT SUM(CASE WHEN inside20=1 AND td=1 THEN 1 ELSE 0 END) FROM drives d WHERE d.season=e.season AND d.game_id=e.game_id AND d.offense=e.offense),
               CASE WHEN g.total_line IS NULL OR g.spread_line IS NULL THEN NULL
                    WHEN g.home_team = e.offense THEN (g.total_line + g.spread_line) / 2.0
                    ELSE (g.total_line - g.spread_line) / 2.0 END
        FROM pbp_events e
        LEFT JOIN games g ON g.game_id = e.game_id
        LEFT JOIN team_plays tp ON tp.season = e.season AND tp.game_id = e.game_id AND tp.offense = e.offense
        GROUP BY e.season, e.week, e.game_id, e.offense
        """)
        # Defense allowed by the scoring player's position (crosswalked through player_game).
        c.execute("""
        INSERT INTO def_pos_game
        SELECT e.season, e.week, e.game_id, e.defense, e.offense,
               COALESCE(pg.position, CASE WHEN e.position IN ('QB','RB','WR','TE','FB') THEN e.position ELSE 'UNKNOWN' END) AS pos,
               SUM(e.td), SUM(e.xtd), COUNT(*),
               SUM(e.event_type='run' AND e.yards_to_goal<=5), SUM(e.event_type='run' AND e.yards_to_goal<=10),
               SUM(e.event_type='run' AND e.yards_to_goal<=20), SUM(e.event_type='pass' AND e.yards_to_goal<=5),
               SUM(e.event_type='pass' AND e.yards_to_goal<=10), SUM(e.event_type='pass' AND e.yards_to_goal<=20),
               SUM(e.event_type='pass' AND e.ez_proxy=1),
               SUM(CASE WHEN e.event_type='run' THEN e.td ELSE 0 END), SUM(CASE WHEN e.event_type='pass' THEN e.td ELSE 0 END)
        FROM pbp_events e
        LEFT JOIN player_game pg ON pg.season=e.season AND pg.week=e.week AND pg.player_id=e.player_id AND pg.team=e.offense
        WHERE e.defense <> ''
        GROUP BY e.season, e.week, e.defense, pos
        """)
    n_team = c.execute("SELECT COUNT(*) FROM team_game").fetchone()[0]
    n_def = c.execute("SELECT COUNT(*) FROM def_pos_game").fetchone()[0]
    log(f"team_game: {n_team:,} rows; def_pos_game: {n_def:,} rows")
    return {"team_game": n_team, "def_pos_game": n_def}
