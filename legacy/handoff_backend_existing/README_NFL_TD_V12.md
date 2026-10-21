NFL Touchdown Research Model v1.2 — October 21 2026

NEW: Week 7 provisional top-three anytime TD shortlist, near-miss event extractor,
play-based xTD scaffolding, and ranked 25-player pilot cohort.

The three selected names are Jahmyr Gibbs, Christian McCaffrey, Derrick Henry,
based on role evidence and the user's Week 7 Venom screenshot. These are not
calibrated independent predictions; check lineups and current odds. The simple
product of their Venom screenshot probabilities is 0.58*0.55*0.50=15.95%,
assuming independence, which is not a proven true three-leg hit rate.

Michael Wilson Week 4 example: 13 targets, three on final four offense snaps
at Giants, zero TDs. Whether the three were end-zone targets/drops is unverified.
Do not assign xTD without play by play (PBP).

Event extraction: python nfl_td_opportunity_v12.py --pbp nfl_pbp.csv --out-dir .

Input requires nflverse-like play by play with season, week, posteam, defteam,
yardline_100, air_yards, play_type, receiver_player_name, rusher_player_name.
Strongly recommended include game_type, two_point_attempt, no_play,
pass_touchdown, rush_touchdown and play_id. Endzone target is a geometric
proxy (air_yards >= yardline_100). It is not proof of a drop/catchability.

The supplied PBP pipeline has been tested with a synthetic four-row dataset,
not real Week 1-6 2026 PBP; no historical xTD figures have been computed.

Ranked Pilot: ranks 25 selected players by a simple index of pregame recent
opportunities and recent TD rate. It is not full-league all-scorer ranking;
previous selected pilot sample biased toward stars.

Sources:
https://nflfastr.com/reference/fast_scraper.html
https://github.com/nflverse/nflverse-pbp
https://athlonsports.com/nfl/arizona-cardinals/michael-wilson-stock-climbs-marvin-harrison-jr-dips-cardinals-loss-giants
https://venomanalytics.io/ (user-provided Week 7 screenshots)

Before full production: load multiple seasons PBP, avoid lookahead, validate
full NFL eligible player universe, estimate conversion rates from pregame
history, calibrate probabilities, check game actives/odds.
