from engine import picklog


def test_tiers_match_the_site():
    assert picklog.tier("td", 0.55) == "Strong"
    assert picklog.tier("td", 0.10) == "Long shot"
    assert picklog.tier("props", 0.60) == "Solid"
    assert picklog.tier("props", 0.51) == "Coin flip"


def test_drift_needs_enough_picks_and_a_real_gap():
    few = [{"p": 0.7, "result": 0}] * 20
    assert picklog._summary(few)["drift"] is None
    cold = [{"p": 0.7, "result": int(i % 2 == 0)} for i in range(200)]  # 50% hit on 70% chances
    assert picklog._summary(cold)["drift"] == "running cold"
    fair = [{"p": 0.5, "result": int(i % 2 == 0)} for i in range(200)]
    assert picklog._summary(fair)["drift"] is None


def test_estimated_line_follows_a_role_change():
    # A backup QB now starting: recent median 4 attempts, projection 24 -> the projection's line, not 4.5.
    assert picklog._estimated_line(23.9, 4.0) == (23.5, "projected")
    assert picklog._estimated_line(37.2, 38.5) == (38.5, "usual")
