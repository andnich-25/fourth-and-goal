import numpy as np

from engine import models


def test_top_end_pulls_overconfident_chances_down():
    rng = np.random.default_rng(3)
    p = rng.uniform(0.02, 0.8, 40000)
    truth = np.where(p > 0.5, 0.5 + (p - 0.5) * 0.3, p)  # model runs high above 50%
    y = (rng.random(p.size) < truth).astype(int)
    top = models.TopEnd(0.5).fit(p, y)
    q = top.predict(np.array([0.2, 0.7]))
    assert abs(q[0] - 0.2) < 0.03 and abs(q[1] - 0.56) < 0.04
    assert np.all(np.diff(top.predict(np.linspace(0.01, 0.95, 50))) >= 0)


def test_top_end_walk_forward_uses_only_earlier_weeks():
    t = np.repeat(np.arange(1, 13), 500)
    p = np.full(t.size, 0.6)
    y = np.zeros(t.size)
    y[t == 12] = 1.0  # outcomes of the week being corrected must not leak into its own correction
    y[(t < 12) & (np.arange(t.size) % 2 == 0)] = 1.0
    out = models.top_end_walk_forward(t, p, y)
    assert np.allclose(out[t <= 8], 0.6)  # fewer than 8 earlier weeks: unchanged
    assert abs(out[t == 12][0] - 0.5) < 0.02
