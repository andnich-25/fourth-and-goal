# Data dictionary and integration contract

## Full-data importer behavior
`backend_existing/nfl_full_pbp_engine.py` runs from an internet-enabled computer and imports:
- `pbp_2023.csv`, `pbp_2024.csv`, `pbp_2025.csv`, `pbp_2026.csv`
- `stats_2023.csv`, `stats_2024.csv`, `stats_2025.csv`, `stats_2026.csv`
- `roster_2026.csv`
Exact release URLs are in `README_NFL_FULL_DATABASE.md` and source code. Current engine is fixed to season 2026 with `--predict-week 7` by default, using 2023–2025 xTD training. Generalize this carefully only with tests.

Run: `python3 backend_existing/nfl_full_pbp_engine.py --data-dir nfl_data --db nfl_touchdown.sqlite --out-dir nfl_results --predict-week 7`
For offline CSV files: add `--offline`.

## SQLite tables (actual existing code)
`sources(kind, season, filename, source_url, rows_imported, imported_at)`
`pbp(season, week, game_id, play_id, offense, defense, event_type, player_id, player_name, position, yards_to_goal, air_yards, completed, td, ez_proxy, description)`
`player_week(season, week, player_id, player_name, position, team, opponent, carries, targets, receptions, rush_tds, rec_tds, pass_tds, season_type)`
`roster_week(season, week, player_id, player_name, position, team, status)`
**Note**: `pbp` indexes receiver target/rush player-events; raw PBP CSV remains on disk and includes other events, so the SQLite `pbp` table is not all plays in the game.

## Output schema (real code)
`nfl_results/build_status.json`:
- season, prediction_week, train_seasons, independent_pbp_training_events, imported_2026_pbp_events, imported_2026_offenses, imported_2026_games, current_weeks, players_weekly_rows, offensive_roster_player_weeks, player_opportunity_rows, defense_rows, NOT_CHARTED, DATA_SOURCE, BACKTEST_WARNING.

`nfl_results/2026_scoring_play_events.csv`: season, week, game_id, play_id, offense, defense, player_id, player, position, play_type, yards_to_goal, air_yards, end_zone_target_PROXY, completed, td, play_xTD, missed_expected_TD, play_description.

`2026_player_week_scoring_opportunities.csv`: season, week, team, opponent, player_id, player, position, opportunities, touchdowns, xTD, goal5_carries, goal10_carries, rz_carries, goal5_targets, goal10_targets, rz_targets, ez_target_proxy, missed_rz_targets, missed_goal5_carries.

`2026_ALL_players_weekly_box_and_opportunity.csv`: season, week, team, opponent, player_id, player, position, rush_attempts, targets, receptions, rushing_tds, receiving_tds, passing_tds, player_anytime_tds, scored_anytime, goal5_carries, goal10_carries, redzone_carries, goal5_targets, goal10_targets, redzone_targets, endzone_target_PROXY, play_based_xTD.

`2026_ALL_offensive_roster_player_weeks.csv`: season, week, team, player_id, player, position, roster_status, has_boxscore_row, anytime_touchdowns, scored_anytime, goal5_carries, rz_carries, goal5_targets, goal10_targets, play_based_xTD.

`2026_defense_position_allowed_week.csv`: season, week, defense, opponent, position, opportunities, touchdowns, xTD, goal5_carries, goal10_carries, rz_carries, goal5_targets, goal10_targets, rz_targets, ez_target_proxy, missed_rz_targets, missed_goal5_carries.

`2026_defense_last6_by_position.csv`: defense, offensive_position, games, weeks + above opportunity/touchdown fields. **This is computed as of the import cut-off**; for prior-week backtests recompute at each week's own cutoff, not this current table.

`historic_xtd_conversion_rates.csv`: event_type, field_position_bucket, airyard_flag, touchdowns, opportunities, smoothed_td_rate.

## Definitions (critical)
- `yardline_100`: yards from offense to opponent's end zone BEFORE snap.
- `goal5_carries`: counted runs from yards-to-goal `<= 5`.
- `goal10_carries`: counted runs from `<= 10` (inclusive of inside five).
- `rz_carries`: counted runs from `<=20`.
- `goal5_targets`, `goal10_targets`, `rz_targets`: passes targeted to a receiver when LOS is inside the 5/10/20; **not** necessarily caught in end zone.
- `end_zone_target_PROXY`: 1 if a pass's `air_yards >= yardline_100`, with location inference limitations; never print unqualified 'confirmed end zone target'.
- `missed_rz_targets`: a target inside 20 that did not lead to a touchdown; not evidence of a 'drop'. `missed_goal5_carries`: carries inside 5 without touchdown. These are retrospective missed *TD opportunities*, not all bad plays.
- `play_xTD`: historical conditional TD rate smoothed toward run/pass family prior, trained on 2023–2025, computed for observed 2026 player run/target events. **Not** a player's next-game P(TD).
- `TD debt`: xTD minus TDs; negative does **not** imply a TD is due.
- `scored_anytime`: one if player scored rushing or receiving TD in that game, 0 otherwise. Passing TDs thrown by QBs do not count as anytime TDs under standard 'anytime scorer' rules.
- `position`: offensive player's position; defense-vs-position stats indicate where opposing TDs occurred, not which defenders were assigned.

## Venom manual snapshot observations
See `data_reference/venom_snapshot_week7_from_user_screenshots.csv` and `data_reference/venom_defensive_notes_week7.csv`. These are handwritten transcriptions of **user-provided screenshots**, not all players, not current odds and not official Venom exports. Venom Score is a ranking number; `Venom TD probability` a separate percent.

## Recommended API endpoints
- `GET /api/health` -> `{status, engine_version, data_loaded}`
- `GET /api/data/status` -> `build_status.json` plus freshness/validation state; if not loaded `ready:false`.
- `POST /api/data/refresh` -> async background job ID, progress; never block UI for entire import; only local authenticated/admin use if hosted.
- `GET /api/weeks?season=2026`
- `GET /api/rankings?season=2026&week=7&position=RB&sort=...&page=...` -> array of typed candidate rows, `model_version`, `as_of` and `fields_available`.
- `GET /api/players/{player_id}?season=2026&week=7` -> history, event ledger, xTD, opponent matchup, source refs.
- `GET /api/defenses?season=2026&week=7` -> prior-only allowed by position, all 32 teams, count of actual games.
- `GET /api/defenses/{team}?season=2026&week=7`
- `GET /api/weekly-top3?season=2026&week=7` -> up to three, reasons, status + model provenance.
- `POST /api/weekly-top3/lock` -> immutable chosen leg IDs + timestamp + data cutoff.
- `GET /api/backtest/summary?season=2026`, `GET /api/backtest/weeks`, `GET /api/backtest/picks`.
- `POST /api/venom/manual-import` -> validate provided CSV and save timestamped observations; no bypass of permission/access controls.

## Data-quality gates
- Training pre-2026 PBP has >=50,000 eligible event records.
- Current 2026 PBP through Week 6: >=30 offenses, >=70 games and current week coverage inclusive through Week 6.
- 2026 roster input >=1000 offensive player-week rows.
- The presence of `build_status.json` alone does not prove today's freshness; display file modification and source URL timestamps.
- Do not treat missing probabilities, unknown injury status or empty defensive splits as zero.
