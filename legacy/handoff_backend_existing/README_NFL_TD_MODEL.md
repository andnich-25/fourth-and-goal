# NFL Touchdown Research Lab — Version 0.1

**Created:** 2026-10-21  
**Current season:** 2026, Week 7 preview  
**Status:** Initial research prototype. Not validated for wagering or claiming league-wide hit rates.

## Files

- `NFL_TD_Model_2026_Pilot.xlsx`: Dashboard, Week 7 candidates, every historical prediction, all manually checked player-game inputs, model notes, and links to official game logs.
- `nfl_td_model.py`: Reusable Python model, walk-forward testing, pilot rankings, and an optional full-league `nflreadpy` loader.
- `nfl_2026_verified_pilot_player_games.csv`: 137 player-game records from 26 players' 2026 NFL.com logs, covering Weeks 1–6.
- `nfl_2026_walk_forward_pilot_backtest.csv`: Every Week 3–6 scored prediction with training history features and pregame probabilities.
- `nfl_2026_week7_pilot_candidates.csv`: Prototype Week 7 player shortlist, with Venom's screenshot probabilities displayed as *comparisons only*.
- `nfl_2026_pilot_metrics.json`: Numerical validation results.

## Actual first backtest — no hindsight

| Metric | Model | Simple smoothed scoring-rate baseline |
|---|---:|---:|
| Top 5 anytime TD hit rate, evaluated Weeks 3–6 | **10/20 = 50%** | **12/20 = 60%** |
| Brier score (lower better) | **0.2513** | **0.2824** |
| AUC (0.5=random) | **0.441** | **0.528** |
| Log loss (lower better) | **0.6963** | **0.7739** |

Model top-five hits by week: Week 3: 2/5, Week 4: 3/5, Week 5: 2/5, Week 6: 3/5.  
Baseline: 2/5, 3/5, 4/5, 3/5.

**87 historical player-games were eligible for evaluation**, because some players were on bye, injured, or lacked history. 53 of the 87 player-games recorded a touchdown. The high scoring prevalence reveals significant sample-selection bias: the cohort consists of established, high-profile players, not the entire eligible league. Results must *not* be generalized to all NFL players. Week 1 is an observation period. Weeks 3–6 are walk-forward holdout predictions, each trained on data from earlier weeks only.

The model **fails to outperform the simple baseline when choosing five players each week.** Probability error is better, but ranking discrimination is worse. Its Week 7 player probabilities are **experimental**, not validated individual likelihoods.

## Statistical model

1. Define a scoring event as at least one **rushing or receiving** touchdown in a game. Quarterback passing touchdowns do *not* count as that QB scoring an anytime touchdown.
2. Build player opportunity inputs using only the **prior four played games** (recency weights 0.75 per older game): carries, receptions, scoring frequency, opportunity trend and role indicators.
3. Apply shrinkage on recent scoring frequency using fixed role priors (RB 0.36, WR 0.24, TE 0.19, QB 0.12). These are illustrative model hyperparameters, not source statistics.
4. Train logistic regression with fixed ridge regularization (C=0.35) on earlier eligible player-games, then forecast the next week.
5. In **full NFLverse mode only**, calculate each defense's prior touchdowns allowed per offensive position using only completed games before the predicted week, with smoothing equivalent to four pseudo-games. Do not extrapolate this from the incomplete pilot.
6. Validate Brier score, log loss, AUC and top-three/top-five/top-ten hit rates. Benchmark against the recent smoothed scoring rate of each player.

## Venom screenshot integration — what is and is not supported

The supplied screenshots give independent Week 7 rankings and anytime TD estimates, including Gibbs 58% (score 90.3), McCaffrey 55%, Henry 50%, Walker 49%, St. Brown 40%, and Golden 35%. They also show Green Bay allowing 10 RB touchdowns over six games, Detroit allowing nine TE touchdowns over five games, and Gibbs's scoring opportunity breakdown.

These figures are shown in the Week 7 file as independent matchup signals/comparators. They **do not** enter Weeks 3–6 model inputs because historical pregame Venom snapshots are unavailable. Training or testing on today's Week 7 figures would be temporal leakage. A true combined model will require Venom's week-by-week **historical** pre-kickoff feature snapshots (even weekly screenshots or an export).

## Run the included pilot offline

```
pip install pandas numpy scikit-learn
python nfl_td_model.py --input nfl_2026_verified_pilot_player_games.csv --out-dir results
```

## Run a much broader league-wide backtest (internet required)

```
pip install pandas numpy scikit-learn nflreadpy polars pyarrow
python nfl_td_model.py --nflverse --out-dir results
```

The second command uses `nflreadpy.load_player_stats([2026], summary_level='week')`, aggregates all NFL team/opponent player stats for Weeks 1–6, and adds strictly past-game opponent-position TD concessions. It runs on a connected computer; **the full-league run has not been performed here**, because NFLverse release files could not be downloaded into this execution environment. Field names or team codes may require a small update if the external feed changes.

For future weeks, update the week's matchup mapping and review injuries and roles. Do not consider a prediction finalized until inactive/bye/role changes have been checked.

## Next improvements in order of expected value

1. **Full league backtest**, not a hand-picked cohort, preferably using 2024–2025 seasons for training as well as full 2026 games.
2. **Play-by-play opportunity inputs**: targets (not just receptions), touches inside 20/10/5, goal-line carries, snap and route shares. NFLverse play-by-play has field-position and scoring information.
3. **Situation-conditioned defensive rates**, including rushing/receiving TDs by RB/WR/TE/QB, opponent red-zone trips, dropback EPA/explosive pass rates, and defensive shifts after personnel injuries.
4. **Coverage-vs-route matchup** only where source-tracked alignment/coverage data can be verified. Do not invent Cover 3 route vulnerability splits.
5. **Calibration and rolling validation**: compare against simple player rates and bookmaker/no-vig implied probabilities; use 2026 Week 7 onward as forward tests. Avoid overfitting to these six weeks.
6. **Model acceptance criteria**: must meaningfully beat baseline on top-five precision and Brier/log loss on enough untouched weeks. Do not use it as a decisive TD recommendation before passing that test.

## Data sources

- Verified 2026 game logs by player: `https://www.nfl.com/players/<slug>/stats/logs/` — direct player URLs in CSV.
- Open-source full-league weekly player statistics and play-by-play: https://github.com/nflverse/nflverse-data and https://nflreadpy.nflverse.com/api/load_functions/
- Venom Analytics: https://venomanalytics.io/ — user-provided screenshots only, not a vendor-supplied data export.

The created model is original and does not claim to reproduce Venom's proprietary 90.3 rating or any proprietary probabilities.
