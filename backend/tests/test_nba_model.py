import json

import numpy as np
import pandas as pd

from nba import history, pipeline, props


def _box(n_games=40, seed=0):
    """Two teams, five players each, one game every other day."""
    rng = np.random.default_rng(seed)
    rows = []
    for g in range(n_games):
        date = pd.Timestamp("2025-11-01") + pd.Timedelta(days=2 * g)
        for team, opp, home in (("BOS", "NY", 1), ("NY", "BOS", 0)):
            for k in range(5):
                mins = float(rng.integers(20, 38))
                rows.append({"game_id": 1000 + g, "season": 2026, "game_date": date, "player_id": (1 if team == "BOS" else 2) * 100 + k,
                             "player_name": f"{team} P{k}", "headshot": "", "pos": "G" if k < 2 else "F" if k < 4 else "C",
                             "team": team, "opp": opp, "home": home, "minutes": mins, "starter": 1, "played": True,
                             "points": float(rng.poisson(mins * 0.5)), "rebounds": float(rng.poisson(5)), "assists": float(rng.poisson(3)),
                             "threes": float(rng.poisson(1.5)), "threes_att": 5.0, "fga": 12.0, "fgm": 6.0, "fta": 3.0, "oreb": 1.0,
                             "turnovers": 2.0, "steals": 1.0, "blocks": 0.0})
    d = pd.DataFrame(rows)
    d["pra"] = d.points + d.rebounds + d.assists
    return d


def test_features_use_only_earlier_games():
    d = _box()
    f = history.build_features(d).sort_values(["player_id", "game_date"])
    p = f[f.player_id == 100].reset_index(drop=True)
    # the first game has no history; the second sees exactly the first game
    assert np.isnan(p.loc[0, "min_l"])
    assert p.loc[1, "min_l"] == p.loc[0, "minutes"]
    assert p.loc[1, "points_pm_l"] * p.loc[1, "min_l"] == p.loc[0, "points"]
    # changing a later game never changes an earlier game's features
    d2 = d.copy()
    d2.loc[(d2.player_id == 100) & (d2.game_id == 1039), "points"] = 99
    f2 = history.build_features(d2).sort_values(["player_id", "game_date"])
    early = f.game_id < 1039
    assert np.allclose(f[early].points_pm_l.fillna(-1).to_numpy(), f2[f2.game_id < 1039].points_pm_l.fillna(-1).to_numpy())


def test_usual_line_is_median_of_previous_ten_rounded_down_plus_half():
    p = pd.DataFrame({"player_id": [1] * 12, "points": [10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 99]})
    line = props.usual_line(p, "points")
    assert np.isnan(line.iloc[4])
    assert line.iloc[11] == np.floor(np.median([12, 14, 16, 18, 20, 22, 24, 26, 28, 30])) + 0.5


def test_published_chance_matches_engine_calibration():
    mu, bands, platt = np.array([22.0]), [0.05] * 5, [0.9, -0.05]
    n, pr = props.nb_params(mu, props.alpha_for([30], bands))
    from scipy import stats as st
    dist = {"type": "nbinom", "cdf": list(st.nbinom.cdf(np.arange(90), n[0], pr[0])), "platt": platt}
    raw = props.p_over_raw(mu, props.alpha_for([30], bands), np.array([21.5]))
    assert abs(pipeline.p_over_dist(dist, 21.5) - props.apply_platt(raw, platt)[0]) < 1e-9


def test_alpha_bands_widen_for_short_minutes():
    rng = np.random.default_rng(1)
    mu = np.full(4000, 10.0)
    mins = np.r_[np.full(2000, 10.0), np.full(2000, 34.0)]
    y = np.r_[rng.negative_binomial(2, 2 / 12, 2000), rng.poisson(10, 2000)]
    b = props.fit_alpha_bands(y, mu, mins)
    assert b[0] > 0.3 and b[-1] < 0.05


def test_freeze_keeps_first_projection(tmp_path, monkeypatch):
    monkeypatch.setenv("NBA_ARCHIVE_DIR", str(tmp_path))
    row = {"player_id": "1", "player_name": "A", "team": "BOS", "game_id": 5, "market": "points", "line": 20.5,
           "line_source": "usual", "p_over": 0.61, "offers": [], "out": False}
    assert pipeline.freeze("2026-10-22", [row])["picks"] == 1
    assert pipeline.freeze("2026-10-22", [dict(row, p_over=0.2)])["kept"]
    assert json.loads((tmp_path / "picks" / "2026-10-22.json").read_text())["picks"][0]["p_over"] == 0.61
