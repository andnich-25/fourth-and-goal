import json
from datetime import datetime, timezone

import pytest

from nba import collect


def test_budget_protects_the_nfl_reserve():
    free = collect.plan_budget(remaining=420, used=80, n_games=10)
    assert free["plan"] == "free" and free["game_lines"] and not free["props"] and free["cost"] == 2
    low = collect.plan_budget(remaining=201, used=299, n_games=10)
    assert not low["game_lines"] and not low["props"] and low["cost"] == 0
    paid = collect.plan_budget(remaining=15000, used=5000, n_games=10)
    assert paid["plan"] == "paid" and paid["game_lines"] and paid["props"] and paid["cost"] == 2 + 50
    assert not collect.plan_budget(remaining=None, used=None, n_games=10)["game_lines"]
    assert not collect.plan_budget(remaining=400, used=100, n_games=0)["game_lines"]


@pytest.fixture()
def arch(tmp_path, monkeypatch):
    monkeypatch.setenv("NBA_DATA_DIR", str(tmp_path / "nba"))
    monkeypatch.setenv("NBA_ARCHIVE_DIR", str(tmp_path / "archive"))
    monkeypatch.setenv("ODDS_API_KEY", "k")
    return tmp_path / "archive"


def test_odds_snapshot_paid_plan(arch, monkeypatch):
    calls = []

    def fake(url, params=None):
        calls.append(url)
        hdr = {"x-requests-remaining": "19000", "x-requests-used": "1000"}
        if url.endswith("/events"):
            return [{"id": "e1", "commence_time": "2026-10-22T23:30:00Z", "home_team": "New York Knicks",
                     "away_team": "Los Angeles Clippers"}, {"id": "x", "home_team": "Team Stars", "away_team": "World"}], hdr
        if url.endswith("/odds") and "/events/" not in url:
            return [{"id": "e1", "bookmakers": [{"key": "fanduel", "markets": [
                {"key": "totals", "outcomes": [{"name": "Over", "point": 224.5, "price": -110}]},
                {"key": "spreads", "outcomes": [{"name": "New York Knicks", "point": -4.5, "price": -112}]}]}]}], hdr
        return {"bookmakers": [{"key": "draftkings", "markets": [{"key": "player_points", "outcomes": [
            {"name": "Over", "description": "Jalen Brunson", "point": 26.5, "price": -115},
            {"name": "Under", "description": "Jalen Brunson", "point": 26.5, "price": -105}]}]}]}, hdr

    monkeypatch.setattr(collect, "_get_json", fake)
    now = datetime(2026, 10, 22, 16, 0, tzinfo=timezone.utc)
    r = collect.save_odds("2026-10-22", log=lambda m: None, now=now)
    snap = json.loads((arch / "odds" / "2026-10-22.json").read_text())
    assert r["props"] == 2 and r["game_lines"] == 2
    assert snap["games"] == [{"event_id": "e1", "commence_time": "2026-10-22T23:30:00Z", "home": "NY", "away": "LAC"}]
    assert {l["team"] for l in snap["game_lines"]} == {"Over", "NY"}
    assert snap["props"][0] == {"event_id": "e1", "market": "points", "player": "Jalen Brunson", "book": "draftkings",
                                "side": "over", "line": 26.5, "price": -115, "updated": None}
    n = len(calls)
    collect.save_odds("2026-10-22", log=lambda m: None, now=now)   # kept: no second spend the same day
    assert len(calls) == n


def test_free_plan_takes_game_lines_only(arch, monkeypatch):
    def fake(url, params=None):
        hdr = {"x-requests-remaining": "400", "x-requests-used": "100"}
        if url.endswith("/events"):
            return [{"id": "e1", "commence_time": "2026-10-22T23:30:00Z", "home_team": "Boston Celtics",
                     "away_team": "Utah Jazz"}], hdr
        if "/events/" in url:
            raise AssertionError("props must not be bought on the free plan")
        return [], hdr

    monkeypatch.setattr(collect, "_get_json", fake)
    r = collect.save_odds("2026-10-22", log=lambda m: None, now=datetime(2026, 10, 22, 16, tzinfo=timezone.utc))
    assert r["budget"]["plan"] == "free" and r["props"] == 0


def test_no_key_skips(arch, monkeypatch):
    monkeypatch.delenv("ODDS_API_KEY")
    assert collect.save_odds("2026-10-22", log=lambda m: None) == {"skipped": "no key"}


def test_rosters_saved_by_team_and_read_back_by_athlete_id(arch, monkeypatch):
    from nba import predict

    def fake(url, params=None):
        team = url.rsplit("/teams/", 1)[1].split("/")[0].upper()
        if team == "PHI":
            raise RuntimeError("timeout")
        return {"athletes": [{"id": "3149673" if team == "CLE" else str(hash(team) % 10**6), "displayName": "x"}]}, {}
    monkeypatch.setattr(collect, "_get_json", fake)
    st = collect.save_rosters("2026-10-22", log=lambda *_: None)
    assert st["teams"] == 29 and set(st["errors"]) == {"PHI"}
    assert predict.rosters()[3149673] == "CLE"
