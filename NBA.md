# NBA player props

The same site has an NBA side: use the **NFL / NBA** switch in the header. Pages: Today (strongest leans and tonight's games), Ask, Parlay builder, Player props, player pages, How it works and Track record.

Basketball research, not betting advice. No pick is guaranteed.

## Every day, automatically

`.github/workflows/nba-collect.yml` runs at 16:00 UTC (before tip-off) and on demand from the Actions tab:

1. **Collect** (`python -m nba.collect`): player box scores from 2018-19 on and this season's schedule from [sportsdataverse-data](https://github.com/sportsdataverse/sportsdataverse-data) (ESPN data, refreshed daily upstream), plus the ESPN injury report, scoreboard and every team's roster, and sportsbook prices from The Odds API within budget (below).
2. **Build** (`python -m nba.pipeline`): features, walk-forward check, confidence bands, Due study, same-game correlation, projections for the next slate, and the JSON the site reads (`site-data/nba/`).
3. **Keep** the snapshots nobody else archives (prices, injury reports, scoreboards, each day's frozen leans) on the repository's `nba-data` branch, one file per day.
4. When it finishes, "Refresh data and publish site" republishes the website with the new NBA numbers and the NFL pages from its last full run, so the NFL pipeline is not repeated daily.

Seasons are named by the year they end (2027 = 2026-27).

## The model

For each market (points, rebounds, assists, threes, points + rebounds + assists) a gradient-boosted Poisson regression predicts a player's average from games before tonight only: recent and longer-run minutes, starts, per-minute rate for the stat, shot volume (FGA, 3PA, FTA per minute), both teams' pace, what the opponent allows to his position (guards, forwards, centers) against the league, rest days and home/away. A negative binomial spread around that average gives the chance of any line. Players on short minutes swing more than their average suggests, so the spread is learned separately for five bands of recent minutes.

**Recent seasons count most:** a training game's weight halves every two seasons of age (`nba/props.py: RECENCY_HALF_LIFE`).

**Walk-forward:** from 2021-22 on, the model is refit at the start of every month on earlier games only and predicts that month. The spread and the over/under calibration are learned only from earlier months' out-of-sample predictions. Finished months are cached, so the daily run refits only the current month.

**Gate:** a market shows over/under scores only if, on unseen games, it beats the player-average baseline on CRPS (month-bootstrap CI above zero) and on over/under Brier at the usual line, its chances are calibrated (ECE ≤ 0.025), and it is not worse than the baseline in the last full season.

**Rosters:** the day's ESPN rosters decide each player's team (`nba/predict.py: slate_rows`). Without them, a player traded in the offseason would be projected for his old team until he played for the new one.

**Team scoring check** (`nba/teamfit.py`): players are projected one at a time, so a team that adds scorers projects to more points than it scores. Points (and the points inside PRA) are scaled by `exp(a + b × log(rotation projected points / team's usual points))`, with a and b fit on the walk-forward's out-of-sample predictions. Who counts toward the sum is decided before the game (players who played the team's previous game). It is switched on only if it beats the plain model on the last two full seasons, held out: lean hits 59.6% → 60.4%, 6.0+ leans 65.8% → 66.6%, typical miss 4.93 → 4.92 points.

**Lines:** the book line when prop prices are loaded, otherwise the player's usual line (median of his last 10 games rounded down plus 0.5). Historical book prop lines are not freely available, so the backtest uses the usual line.

## Scores, signals, parlays, record

* **Scores out of 10:** the chance of each side times 10; bands Toss-up / Lean / Solid / Strong with their hit rates on unseen games (players averaging 15+ minutes, the ones the site lists).
* **Edge ($):** our chance of the lean beats the best book price's implied chance by 3+ points (only with prop prices).
* **Due (hourglass):** under his projection in each of his last 4 games while playing 20+ minutes. The Track record page shows how such players did next time; it is a label, never added on top of the model.
* **Parlays:** 40,000 simulated games in the browser (`frontend/src/lib/sim.ts`); same-game links (Gaussian copula by same player / teammates / opponents, markets and positions) are used only if they beat multiplying chances on unseen months (`nba/correlation.py`).
* **Live record:** each day's leans are frozen before tip-off on the `nba-data` branch (`picks/`) and graded against the box scores.

## Odds API budget

The free plan has 500 credits a month and the NFL Saturday pull uses about 90 a week. The event list is free; NBA game lines (spread and total for every game) cost 2 credits; player props cost 5 per game. On the free plan the collector takes game lines only and never goes below 200 credits. On a paid plan (detected automatically from the credit headers) it also takes player props for every game, keeping 1,000 in reserve. Overrides: `NBA_PROPS=always|never|auto`, `NBA_ODDS_RESERVE`.

## Run it locally

```bash
cd backend
python -m nba.collect      # downloads into data/nba/raw
python -m nba.pipeline     # writes ../site-data/nba (the desktop app serves it at /api/nba/)
python -m pytest -q tests/test_nba_collect.py tests/test_nba_model.py
```

The first build runs the full walk-forward (about 30 minutes); later builds refit the current month only.
