# NFL touchdown opportunities — full-league ingestion package

**Build date:** 2026-10-21. **Week-7 target:** no play after Week 6 is permitted in the analysis.

## Honest data status

This package includes a tested, executable **full data loader and event-calculation engine**, not preloaded full NFL data. The nine large official NFLverse CSV release assets could not be downloaded in the present execution environment (network name resolution is disabled). Consequently, no real 2026 league-wide xTD calculations or full-league hit rates are being claimed. **Do not treat the workbook's Venom screenshot example or the separate integration tests as full-league game data.**

The code did pass parser invariants and an end-to-end *synthetic* SQL integration test that confirmed 192 player-game rows, 1,344 offensive roster player-week rows, and proper splitting of scoring opportunities. The synthetic fixtures are not included in the real-world results.

## Run it (Mac)

1. Unzip this folder on an internet-connected Mac with Python 3.10+.
2. Open Terminal in that folder. Run:

```bash
python3 nfl_full_pbp_engine.py --data-dir nfl_data --db nfl_touchdown.sqlite --out-dir nfl_results --predict-week 7
```

Or double-click `RUN_MAC.command` after granting the file permission to run. This downloads each of the nine CSVs, indexes events in SQLite, and creates the scoring CSVs. **The code uses only Python's standard library.** No pip installs required.

Windows PowerShell with Python installed:

```powershell
py -3 nfl_full_pbp_engine.py --data-dir nfl_data --db nfl_touchdown.sqlite --out-dir nfl_results --predict-week 7
```

You can also double-click `RUN_WINDOWS.bat`.

If automatic downloads fail, manually download the nine files listed below and rename them as shown in the **Local file** column. Put them into a folder called `nfl_data`, then use `--offline`:

```bash
python3 nfl_full_pbp_engine.py --offline --data-dir nfl_data --db nfl_touchdown.sqlite --out-dir nfl_results --predict-week 7
```

## Official data sources

| Local file | Source URL |
|---|---|
| pbp_2023.csv | https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2023.csv |
| pbp_2024.csv | https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2024.csv |
| pbp_2025.csv | https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2025.csv |
| pbp_2026.csv | https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_2026.csv |
| stats_2023.csv | https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2023.csv |
| stats_2024.csv | https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2024.csv |
| stats_2025.csv | https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2025.csv |
| stats_2026.csv | https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv |
| roster_2026.csv | https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_2026.csv |

The exact URL templates were verified against the open-source `nflreadr` loader implementations. nflverse source datasets are distributed under applicable open-data licensing; see the release's license / terms when redistributing data.

## Calculations produced

1. **True carries inside five and ten**: field position based on `yardline_100` before the snap, not inferred from season stat lines. Separate rushing touchdowns attributed to the actual rusher.
2. **Targets from inside five/ten/twenty**: all receiver-targeted pass attempts (completions and incompletions), excluding `no_play`, two-point conversions and spikes.
3. **End-zone-target PROXY**: `air_yards >= yardline_100`. This is a useful attempted pass beyond the goal-line proxy, **not a charted end-zone ball-location measurement**. A pass from the goal line does not mean it was thrown into the end zone.
4. **Missed opportunities**: failed pass target from inside 20, or a carry from inside 5 without a TD. **This does not mean 'drop'.** Catchability cannot be determined from basic PBP alone.
5. **Real-data xTD calculation**: smoothed observed TD conversion rates from 2023–2025 eligible player events, separately by run/pass, distance-to-goal bucket, and end-zone proxy. The 2026 events are scored using the *earlier* 2023–2025 rates, so Week 7 results do not train on future 2026 games.
6. **Defensive allowed tables** by offensive QB/RB/WR/TE/FB position, including weekly allowed TDs, xTD, scoring-area opportunities, and a last-six-games aggregate.
7. **Full offensive roster player-weeks** (from weekly_rosters, even without a box-score row) and player-week stats (including no-TD outcomes), with roster status retained. Being on a weekly roster is not proof the player was active or likely to play.
8. **Database safeguards**: blocks publication if historical training has <50,000 eligible events, current week-1–6 has fewer than ~70 unique games or fewer than 30 team offenses, or 2026 offensive roster data is missing. It does not generate fabricated missing data.

## Output files

These appear only after all nine CSV imports succeed:

- `nfl_touchdown.sqlite`: SQLite indexed underlying offensive player events + player-week stats + weekly offensive roster.
- `nfl_results/2026_scoring_play_events.csv`: individual rushing and receiving opportunities + event xTD.
- `nfl_results/2026_player_week_scoring_opportunities.csv`: one row per player/season week who had a counted opportunity.
- `nfl_results/2026_ALL_players_weekly_box_and_opportunity.csv`: weekly player stats, including zero-TD games, joined to red zone opportunity table.
- `nfl_results/2026_ALL_offensive_roster_player_weeks.csv`: complete eligible-position weekly roster source; includes those with no stats and preserves status.
- `nfl_results/2026_defense_position_allowed_week.csv`: defensive concessions by position per week.
- `nfl_results/2026_defense_last6_by_position.csv`: opponent concession totals over recent six games.
- `nfl_results/historic_xtd_conversion_rates.csv`: pre-2026 empirical conversion rates and estimates.
- `nfl_results/build_status.json`: source and completeness audit.

**The original raw PBP CSVs are kept in `nfl_data` unmodified.** They contain all play types, including special teams and flags; SQLite indexes the offensive target/rush subset for efficient TD modeling rather than copying all 370+ columns of every raw row.

## What's still needed after ingest

This package measures actual scoring chances and retrospective expected touchdown counts. It does **not** yet predict an individual's next-game anytime-touchdown probability. A separate forecast must model the team's expected scoring drives, usage allocation, opponent-specific conversion, injury/availability, then calibrate forecasts on held-out player-games. Venom rankings/screenshots may be used as input observations only for the dates they were captured; don't leak Week-7 Venom data into Week-1–6 backtests.

For a Michael Wilson-style near-miss, a receiver's targets from inside the 5 will register even if he fails to catch them. Exact pass location, unforced drops, and contested-catch grading require charting/film and **are not** asserted from basic NFLverse data.

## Quick self-tests

```bash
python3 nfl_full_pbp_engine.py --smoke-test
python3 test_nfl_full_engine.py  # synthetic integration test only
```

Data credits: nflverse, nflfastR/nflreadr, https://github.com/nflverse/nflverse-data .
