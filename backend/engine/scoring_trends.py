"""Who scored this season, and which pregame metrics separated scorers from non-scorers.

Every "pregame" number here is the value the model saw before that game (from the feature cache, built from
earlier games only), so the lift tables show what was knowable in advance, not what happened in the game.
"""
from __future__ import annotations

import json

import pandas as pd

from . import paths
from .backtest import wilson

# metric -> (label, bin edges). Bins are fixed in advance, not chosen to flatter the result.
LIFT_METRICS = {
    "rz_opps_pg": ("Red-zone carries + targets per game", [0, 0.5, 1, 2, 3, 4.5, 99]),
    "goal10_opps_pg": ("Inside-10 carries + targets per game", [0, 0.25, 0.5, 1, 1.5, 2.5, 99]),
    "xtd_pg": ("Play-based xTD per game", [0, 0.1, 0.2, 0.3, 0.45, 0.65, 9]),
    "xtd_share": ("Share of team xTD", [0, 0.05, 0.1, 0.15, 0.22, 0.3, 1.01]),
    "team_implied_total": ("Team implied points", [0, 18, 21, 24, 27, 99]),
    "opp_def_pos_mult": ("Opponent TDs allowed to position vs league", [0, 0.75, 0.9, 1.1, 1.3, 9]),
    "opp_def_rz_td_rate": ("Opponent red-zone TD rate allowed", [0, 0.5, 0.55, 0.6, 0.65, 1.01]),
    "snap_pct": ("Offensive snap share", [0, 0.4, 0.6, 0.75, 0.9, 1.01]),
}


def _features() -> pd.DataFrame:
    import pickle

    with open(paths.results_dir() / "features.pkl", "rb") as f:
        return pickle.load(f)["frame"]


def build(c, season: int) -> dict:
    feats = _features()
    played = feats[(feats.season == season) & (feats.participated == 1) & feats.scored_anytime.notna() & (feats.has_history == 1)].copy()
    weeks = sorted(played.week.unique().tolist())
    if not weeks:
        return {"season": season, "weeks": [], "empty_reason": "No completed games with earlier history this season yet."}
    played["rz_opps_pg"] = played.rz_carries_pg.fillna(0) + played.rz_targets_pg.fillna(0)
    played["goal10_opps_pg"] = played.goal10_carries_pg.fillna(0) + played.goal10_targets_pg.fillna(0)
    played["y"] = played.scored_anytime.astype(int)
    prior = feats[(feats.season == season - 1) & (feats.participated == 1) & feats.scored_anytime.notna() & (feats.has_history == 1)].copy()
    prior["rz_opps_pg"] = prior.rz_carries_pg.fillna(0) + prior.rz_targets_pg.fillna(0)
    prior["goal10_opps_pg"] = prior.goal10_carries_pg.fillna(0) + prior.goal10_targets_pg.fillna(0)
    prior["y"] = prior.scored_anytime.astype(int)

    lift = []
    for m, (label, edges) in LIFT_METRICS.items():
        if m not in played:
            continue
        rows = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            cur = played[(played[m] >= lo) & (played[m] < hi)]
            prv = prior[(prior[m] >= lo) & (prior[m] < hi)] if m in prior else prior.iloc[0:0]
            n, h = len(cur), int(cur.y.sum())
            rows.append({"lo": lo, "hi": hi, "n": n, "scored": h, "rate": h / n if n else None, "ci": wilson(h, n),
                         "prior_n": len(prv), "prior_rate": float(prv.y.mean()) if len(prv) else None})
        valid = played[played[m].notna()]
        lift.append({"metric": m, "label": label, "bins": rows, "missing": int(played[m].isna().sum()),
                     "spearman": float(valid[m].rank().corr(valid.y.rank())) if len(valid) > 30 else None})
    lift.sort(key=lambda x: -(x["spearman"] or 0))

    # Where the touchdowns came from (play-by-play, scoring plays only).
    # Play-by-play has no position column; take it from the player-game ledger.
    ev = pd.read_sql_query("SELECT e.week, e.offense, e.defense, e.event_type, pg.position, e.yards_to_goal, e.player_id, e.player_name "
                           "FROM pbp_events e JOIN player_game pg ON pg.season=e.season AND pg.week=e.week AND pg.player_id=e.player_id "
                           "AND pg.team=e.offense WHERE e.season=? AND e.td=1 AND pg.position IN ('QB','RB','WR','TE')", c, params=(season,))
    buckets = [(1, 2, "1-2"), (3, 5, "3-5"), (6, 10, "6-10"), (11, 20, "11-20"), (21, 100, "21+")]
    origin = []
    for lo, hi, lab in buckets:
        b = ev[(ev.yards_to_goal >= lo) & (ev.yards_to_goal <= hi)]
        origin.append({"yards": lab, "rush": int((b.event_type == "run").sum()), "pass": int((b.event_type == "pass").sum()),
                       "share": len(b) / len(ev) if len(ev) else None})
    by_pos = ev.groupby("position").size().to_dict()

    # Were the scorers visible beforehand? Pregame rank of each scorer in the promoted model's walk-forward run.
    run = c.execute("SELECT run_id, model_version FROM model_runs WHERE kind='walk_forward' ORDER BY created_at DESC LIMIT 1").fetchone()
    rank_dist = None
    if run and run["model_version"] != "none":
        bp = pd.read_sql_query("SELECT week, player_id, team, p, outcome, pregame_eligible FROM backtest_preds WHERE run_id=? AND model=? "
                               "AND season=?", c, params=(run["run_id"], run["model_version"], season))
        if len(bp):
            bp = bp[bp.pregame_eligible == 1].copy()
            bp["rank"] = bp.groupby("week").p.rank(ascending=False, method="first")
            sc = bp[bp.outcome == 1]
            tiers = [(1, 10), (11, 25), (26, 50), (51, 100), (101, 10_000)]
            rank_dist = {"model": run["model_version"], "scorers": int(len(sc)), "tiers": [
                {"ranks": f"{a}-{b}" if b < 10_000 else f"{a}+", "scorers": int(((sc["rank"] >= a) & (sc["rank"] <= b)).sum()),
                 "players": int(((bp["rank"] >= a) & (bp["rank"] <= b) & bp.outcome.notna()).sum()),
                 "rate": float(bp[(bp["rank"] >= a) & (bp["rank"] <= b) & bp.outcome.notna()].outcome.mean())
                 if (((bp["rank"] >= a) & (bp["rank"] <= b) & bp.outcome.notna()).sum()) else None} for a, b in tiers]}

    # Repeat scoring: does scoring last game carry forward beyond usage?
    pg = pd.read_sql_query("SELECT season, week, player_id, scored_anytime FROM player_game WHERE participated=1 AND season=? "
                           "ORDER BY player_id, week", c, params=(season,))
    pg["prev"] = pg.groupby("player_id").scored_anytime.shift()
    rep = pg.dropna(subset=["prev"])
    repeat = {str(int(k)): {"n": int(len(g)), "rate": float(g.scored_anytime.mean())} for k, g in rep.groupby("prev")}

    # Leaders: most TDs and most scoring chances so far.
    leaders = pd.read_sql_query(
        "SELECT player_id, player_name, position, team, COUNT(*) AS games, SUM(anytime_tds) AS tds, SUM(scored_anytime) AS td_games, "
        "SUM(rz_carries + rz_targets) AS rz_opps, SUM(goal10_carries + goal10_targets) AS goal10_opps, ROUND(SUM(xtd), 2) AS xtd "
        "FROM player_game WHERE season=? AND participated=1 GROUP BY player_id, team ORDER BY tds DESC, xtd DESC LIMIT 25", c,
        params=(season,))
    defenses = pd.read_sql_query(
        "SELECT defense, position, SUM(touchdowns) AS tds, COUNT(DISTINCT week) AS games, ROUND(SUM(xtd), 2) AS xtd FROM def_pos_game "
        "WHERE season=? GROUP BY defense, position", c, params=(season,))
    return {"season": season, "weeks": weeks, "player_games": int(len(played)), "scorer_games": int(played.y.sum()),
            "base_rate": float(played.y.mean()), "touchdowns": int(len(ev)), "by_position": by_pos, "origin": origin,
            "lift": lift, "pregame_rank_of_scorers": rank_dist, "repeat_scoring": repeat,
            "leaders": json.loads(leaders.to_json(orient="records")),
            "defenses": json.loads(defenses.to_json(orient="records")),
            "notes": ["Pregame metrics are the values available before each game (earlier games only).",
                      f"Grey numbers are the same bins in {season - 1}, to show which patterns are stable rather than early-season noise.",
                      "Six weeks is a small sample: bins with fewer than 100 player-games have wide intervals."]}
