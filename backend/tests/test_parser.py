"""Parser invariants from docs/ACCURACY_AND_TESTING.md (no real data needed)."""
from engine.aggregates import category
from engine.ingest import parse_pbp, parse_player_stats

BASE = {"season": "2026", "week": "4", "game_id": "2026_04_ARI_NYG", "play_id": "181", "season_type": "REG",
        "posteam": "ARI", "defteam": "NYG", "play_type": "pass", "yardline_100": "4", "pass_attempt": "1",
        "receiver_player_id": "id-w", "receiver_player_name": "M.Wilson", "receiver_player_position": "WR",
        "air_yards": "5", "complete_pass": "0", "pass_touchdown": "0", "touchdown": "0", "td_player_id": ""}
RUSH = dict(BASE, play_type="run", rusher_player_id="id-r", rusher_player_name="J.Gibbs", rusher_player_position="RB",
            rush_attempt="1", receiver_player_id="", receiver_player_name="", air_yards="")


def test_incomplete_goal_line_target_is_opportunity_not_td():
    e = parse_pbp(BASE, 2026, 6)
    assert e is not None and e[13] == 0  # td
    assert e[14] == 1  # air 5 >= 4 yards to goal -> end-zone PROXY


def test_ez_proxy_requires_air_yards_to_reach_goal():
    assert parse_pbp(dict(BASE, air_yards="2"), 2026, 6)[14] == 0
    assert category("pass", 4, 5.0) == ("pass", "03-05", "EZ_PROXY")
    assert category("pass", 4, 2.0) == ("pass", "03-05", "NON_EZ")


def test_td_carry_inside_five():
    e = parse_pbp(dict(RUSH, rush_touchdown="1", td_player_id="id-r"), 2026, 6)
    assert e[6] == "run" and e[13] == 1 and e[10] == 4
    assert category("run", 4, None) == ("run", "03-05", "CARRY")


def test_exclusions_and_embargo():
    assert parse_pbp(dict(BASE, no_play="1"), 2026, 6) is None
    assert parse_pbp(dict(BASE, two_point_attempt="1"), 2026, 6) is None
    assert parse_pbp(dict(BASE, qb_spike="1"), 2026, 6) is None
    assert parse_pbp(dict(BASE, week="7"), 2026, 6, embargo_season=2026) is None
    assert parse_pbp(dict(BASE, season_type="POST"), 2026, None) is None
    # The embargo only applies to the current season, not to history.
    assert parse_pbp(dict(BASE, week="12"), 2025, 6, embargo_season=2026) is not None


def test_td_credited_only_to_scoring_player():
    # Receiver catches, fumbles, teammate recovers in the end zone: not the receiver's TD.
    e = parse_pbp(dict(BASE, complete_pass="1", pass_touchdown="1", touchdown="1", td_player_id="someone-else"), 2026, 6)
    assert e[13] == 0
    e = parse_pbp(dict(BASE, complete_pass="1", pass_touchdown="1", touchdown="1", td_player_id="id-w"), 2026, 6)
    assert e[13] == 1


def test_stats_parser_keeps_zero_td_games_and_passing_tds_separate():
    row = {"player_id": "qb1", "player_display_name": "QB", "position": "QB", "season_type": "REG", "week": "3",
           "team": "ARI", "opponent_team": "SF", "carries": "4", "targets": "0", "receptions": "0",
           "rushing_tds": "0", "receiving_tds": "0", "passing_tds": "3", "game_id": "g"}
    t = parse_player_stats(row, 2026)
    assert t[11] == 0 and t[12] == 0 and t[13] == 3  # rush, rec, pass TDs
    assert parse_player_stats(dict(row, position="LB"), 2026) is None


def run_all():
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
