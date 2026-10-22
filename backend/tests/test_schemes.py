import numpy as np
import pandas as pd

from engine import schemes

TEAMS = [f"T{i:02d}" for i in range(20)]


def _season(season, rng, blitzer="T00", leaky_pa="T01", man_team="T02"):
    """Every team plays every week; T00 blitzes a lot, T01 gets torched by play action, T02 plays man."""
    pbp, ftn, part = [], [], []
    pid = 0
    for week in range(1, 13):
        for i, off in enumerate(TEAMS):
            de = TEAMS[(i + week) % len(TEAMS)]
            if de == off:
                continue
            gid = f"{season}_{week:02d}_{off}_{de}"
            for _ in range(30):
                pid += 1
                drop = rng.random() < 0.6
                pa = drop and rng.random() < 0.25
                rushers = 5 if (de == blitzer and rng.random() < 0.7) or rng.random() < 0.2 else 4
                epa = rng.normal(0.6 if (pa and de == leaky_pa) else 0.0, 1.0)
                pbp.append({"game_id": gid, "play_id": pid, "season_type": "REG", "week": week, "posteam": off, "defteam": de, "down": 1 + pid % 3,
                            "ydstogo": 10, "play_type": "pass" if drop else "run", "qb_dropback": int(drop), "qb_scramble": 0,
                            "pass_length": "short", "pass_location": "middle", "air_yards": 5.0 if drop else np.nan, "run_location": None if drop else "left",
                            "run_gap": None if drop else "end", "epa": epa, "success": int(epa > 0), "qb_hit": 0, "sack": 0,
                            "two_point_attempt": 0, "pass": int(drop), "rush": int(not drop)})
                ftn.append({"nflverse_game_id": gid, "nflverse_play_id": pid, "n_defense_box": 7, "is_motion": "FALSE", "is_play_action": str(pa).upper(),
                            "is_screen_pass": "FALSE", "is_rpo": "FALSE", "is_qb_out_of_pocket": "FALSE", "n_blitzers": 0, "n_pass_rushers": rushers})
                man = de == man_team or rng.random() < 0.2
                part.append({"nflverse_game_id": gid, "play_id": pid, "defense_man_zone_type": "MAN_COVERAGE" if man else "ZONE_COVERAGE",
                             "defense_coverage_type": "COVER_1" if man else "COVER_3", "was_pressure": False})
    return pd.DataFrame(pbp), pd.DataFrame(ftn), pd.DataFrame(part)


def test_schemes_find_the_blitzer_the_man_team_and_the_play_action_leak(tmp_path):
    rng = np.random.default_rng(3)
    for season in (2025, 2026):
        pbp, ftn, part = _season(season, rng)
        pbp.to_csv(tmp_path / f"pbp_{season}.csv", index=False)
        ftn.to_csv(tmp_path / f"ftn_{season}.csv", index=False)
        if season == 2025:   # this season's coverage isn't published yet
            part.to_csv(tmp_path / f"participation_{season}.csv", index=False)
    res = schemes.build(2026, tmp_path)
    d = res["defenses"]
    assert res["coverage_season"] == 2025 and "2025" in res["coverage_note"]
    assert d["T00"]["rates"]["blitz_rate"]["value"] > 0.7 > d["T05"]["rates"]["blitz_rate"]["value"]
    assert d["T02"]["rates"]["man_rate"]["value"] == 1.0 and d["T02"]["coverage_mix"]["Cover 1"] == 1.0
    assert res["repeatability"]["blitz_rate"]["label"] == "repeats"
    assert d["T01"]["weak_spots"][0]["split"] == "play_action"
    assert next(s for s in d["T02"]["splits"] if s["split"] == "vs_man")["season"] == 2025
    m = schemes.matchup("T05", "T00", res)
    assert m and m[0]["scheme"].startswith("Blitz")
