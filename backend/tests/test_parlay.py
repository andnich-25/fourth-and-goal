"""Odds-feed parsing and the same-game correlation maths."""
from __future__ import annotations

import numpy as np
import pytest
from scipy.stats import multivariate_normal, norm

from engine import correlation, db, odds


def test_bvn_matches_scipy():
    for h, k, r in ((-0.5, 0.3, 0.4), (1.2, -1.0, -0.3), (0.0, 0.0, 0.8)):
        ref = multivariate_normal(mean=[0, 0], cov=[[1, r], [r, 1]]).cdf([h, k])
        assert abs(float(correlation.bvn_cdf(np.array(h), np.array(k), r)) - ref) < 1e-5
    # rho = 0 is the independence product
    assert abs(float(correlation.p_both(np.array(0.3), np.array(0.6), 0.0)) - 0.18) < 1e-9


def test_bucket_keys_are_order_free():
    a = correlation.keys_for("team", "td", "WR", "pass_tds", "QB")
    b = correlation.keys_for("team", "pass_tds", "QB", "td", "WR")
    assert a == b == ("team|pass_tds.QB|td.WR", "team|pass_tds|td", "team")


def test_correlation_recovers_known_rho():
    rng = np.random.default_rng(3)
    n, rho = 40000, 0.4
    z = rng.multivariate_normal([0, 0], [[1, rho], [rho, 1]], size=n)
    pa, pb = np.full(n, 0.3), np.full(n, 0.5)
    ya, yb = (z[:, 0] < norm.ppf(pa)).astype(int), (z[:, 1] < norm.ppf(pb)).astype(int)
    import pandas as pd
    P = pd.DataFrame({"pa": pa, "pb": pb, "ya": ya, "yb": yb, "leaf": "team|a.X|b.Y", "parent": "team|a|b", "root": "team"})
    est = correlation.estimate(P, correlation.pair_loglik(P))
    assert abs(est["team|a.X|b.Y"]["rho"] - rho) < 0.05


@pytest.fixture()
def oddsdb(tmp_path, monkeypatch):
    monkeypatch.setenv("FG_DATA_DIR", str(tmp_path))
    c = db.connect(tmp_path / "t.sqlite")
    c.execute("INSERT INTO games(game_id, season, week, home_team, away_team) VALUES ('2026_07_NE_CHI', 2026, 7, 'CHI', 'NE')")
    c.execute("INSERT INTO predictions(run_id, season, week, player_id, player_name, team) VALUES ('r', 2026, 7, 'p1', 'D''Andre Swift Jr.', 'CHI')")
    c.execute("INSERT INTO prop_projections(run_id, market, season, week, player_id, player_name, team) VALUES ('r', 'receptions', 2026, 7, 'p2', 'Hunter Henry', 'NE')")
    c.commit()
    return c


def test_odds_feed_matches_players_and_never_guesses(oddsdb, monkeypatch):
    def fake_get(url, params):
        if url.endswith("/events"):
            return [{"id": "e1", "home_team": "Chicago Bears", "away_team": "New England Patriots"}], {"x-requests-remaining": "480"}
        return {"bookmakers": [
            {"key": "draftkings", "markets": [
                {"key": "player_anytime_td", "outcomes": [{"name": "Yes", "description": "DAndre Swift", "price": 120},
                                                          {"name": "Yes", "description": "Somebody Else", "price": 900}]},
                {"key": "player_receptions", "outcomes": [{"name": "Over", "description": "Hunter Henry", "price": -115, "point": 4.5},
                                                          {"name": "Under", "description": "Hunter Henry", "price": -105, "point": 4.5}]}]},
            {"key": "fanduel", "markets": [
                {"key": "player_anytime_td", "outcomes": [{"name": "Yes", "description": "D'Andre Swift", "price": 130}]}]}]}, {}
    monkeypatch.setattr(odds, "_get", fake_get)
    snap = odds.fetch(oddsdb, 2026, 7, "k")
    rows = snap["rows"]
    assert {(r["book"], r["market"], r["player_id"], r["side"], r["price"]) for r in rows} == {
        ("DraftKings", "td", "p1", "yes", 120), ("FanDuel", "td", "p1", "yes", 130),
        ("DraftKings", "receptions", "p2", "over", -115), ("DraftKings", "receptions", "p2", "under", -105)}
    assert snap["unmatched_names"] == 1
    assert odds.load_snapshot(2026, 7)["rows"] == rows


def test_odds_skip_without_key(oddsdb, monkeypatch):
    monkeypatch.delenv("ODDS_API_KEY", raising=False)
    assert odds.maybe_fetch(oddsdb, 2026, log=lambda m: None) is None
