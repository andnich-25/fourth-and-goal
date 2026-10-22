# College football

The site's third side: use the **NFL / CFB / NBA** switch in the header. Pages: This week (picks and every FBS game),
game pages, Ask, Teams (power ratings, ATS and over/under records), Player props (featured games) and Research &
record. College football research, not betting advice. No pick is guaranteed.

## Every day, automatically

`.github/workflows/cfb-collect.yml` runs at 15:00 UTC and on demand from the Actions tab:

1. **Collect** (`python -m cfb.collect`): scores and schedules since 2010 and closing spreads, totals and moneylines from
   many books ([cfbfastR-data](https://github.com/sportsdataverse/cfbfastR-data)), this season's lines from the
   cfbfastR play-by-play, ESPN team and player box scores (sportsdataverse-data), the ESPN scoreboard for the coming
   week (ESPN's posted line for every FBS game, free) and the AP poll, and sportsbook prices within budget (below).
2. **Build** (`python -m cfb.pipeline`): weekly ratings, walk-forward game model, the 5,000-game backtest of every
   market, this week's games and picks, props for featured games, frozen picks and the live record (`site-data/cfb/`).
3. **Keep** scoreboards, polls, prices and each game's frozen picks on the `cfb-data` branch.
4. "Refresh data and publish site" then republishes the website with the new numbers.

## The model

* **Ratings**, refit before every week on earlier games only: opponent-adjusted points, yards per play, plays (pace)
  and turnovers, each a ridge solve over every FBS/FCS team; a game's weight halves every 120 days.
* **Game model**: the ratings and the posted line become an expected margin and total (ridge regression refit every
  week; a season's weight halves every two seasons, so the last two count most).
* **Simulation**: each game is played 5,000 times with pairs of real misses from about the last two seasons. Every
  chance (cover, over, team total, win) is the share of those games; score = chance x 10.

## What testing found (2016 on, every game simulated with the model as it stood that week)

* **Game totals** are the market the model beats: the Strong tier (54%+) hit 53.5% at the closing total and about 59%
  at the opening total, so totals are best bet early in the week.
* **Spreads and moneylines**: no tier beat the price at the close, so they are shown as leans, never as picks.
* **Team totals**: tested only at implied lines (old team-total lines were never archived); no proven tier.
* A tier is a pick only if it beat 52.4% (the -110 break-even) over the whole test, did not lose over the last two
  seasons, and every stronger tier passed too. Props are picks only at book-posted lines.

## Odds API budget

About 12 credits a week from the shared 500: game lines for every game on Tuesday and Saturday (3 credits each), team
totals for up to 4 featured games and props for the top featured game on Saturday. Nothing is bought below a
200-credit reserve (`CFB_ODDS_RESERVE`), so the NFL Saturday pull is protected. `CFB_PROPS=always|never|auto`.

## Run it locally

```bash
cd backend
python -m cfb.collect
python -m cfb.pipeline        # about a minute
python -m pytest -q tests/test_cfb.py
```
