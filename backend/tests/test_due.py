import numpy as np
import pandas as pd

from engine import due


def _frame(signal: float, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for s in (2024, 2025):
        for w in range(1, 18):
            p = rng.uniform(0.05, 0.5, 300)
            gap = rng.normal(0, 1.2, 300)
            z = np.log(p / (1 - p)) + signal * gap
            y = (rng.uniform(size=300) < 1 / (1 + np.exp(-z))).astype(int)
            rows.append(pd.DataFrame({"season": s, "week": w, "p": p, "gap": gap, "outcome": y}))
    return pd.concat(rows, ignore_index=True)


def test_gap_is_only_adopted_when_it_predicts():
    assert due.adjustment_test(_frame(0.0))["gain"] < 0.0005
    assert due.adjustment_test(_frame(0.4))["gain"] > 0.002
