# Predictive validity, auditing and release gates

## Non-negotiable accuracy principles
The goal is high out-of-sample accuracy, not artificially inflated confidence. Many true 50–60% touchdown candidates won't score in a particular week. Selective hit rates can improve by choosing fewer legs; report the resulting sample size and selection coverage. Do not optimize a parlay by ranking arbitrary small-sample apparent hit rates.

## Three layers of scoring intelligence
1. **Actual retrospective opportunity**: verified rushes/targets at inside-5, inside-10 and red-zone distances; xTD of opportunities using play-based historical conversion. Misses count as chance creation, not guaranteed TDs.
2. **Upcoming-week opportunity forecast**: projected team drives, team offensive TDs, player expected rushes/targets, field-location shares; incorporate who is active, projected snaps, role and defense. Must be generated from prior data.
3. **Game anytime-TD probability**: appropriately calibrated P(at least one rushing/receiving TD), not the play-based xTD statistic. Candidate estimate often `1-exp(-lambda)` only as a clearly stated Poisson-based approximation; calibrate and consider overdispersion, offense/defense dependence and game script. Compare to simpler logistic baseline.

## Historical test design
- Training seasons: 2023–2025; 2026 weekly tests via expanding-window chronological backtest with no games or injuries from future weeks available.
- Include **all eligible player-games** including 0 TD outcomes and players not scoring all season, with clear inactive/ineligible exclusions. Sources and coverage logged.
- For evaluation predictions for Week N must be generated only from Weeks < N plus public pregame statuses/odds available at that moment. Do not use Week 7 screenshots for Week 1–6 predictions.
- Rolling opponent metrics use prior completed games ONLY. Recalculate historical defensive rates for each historical cutoff. Beware season changes and shifting depth charts.
- Establish naive baseline: previous scoring rate with Bayesian shrinkage + opportunity-weighted ranking; if actual archived market odds available, compare to margin-adjusted market baseline (don't invent).
- Lock each pregame weekly candidate list and compare after results; never edit frozen history.

## Report all metrics
`hit_rate = hits / eligible predicted selections` per top1, top3, top5, top10; `all_3_score` rate when exactly 3 legs issued; per-position splits; Brier, log loss, reliability calibration bins, ECE, confidence intervals, stratified sample sizes, and coverage (fraction of weeks producing N selections). Measure false positives/negatives, ranking lift against baseline and drift.

## Present data status responsibly
- Full current dataset from importer: currently NOT present in package.
- Real matchup probability model: NOT trained/validated on full NFL.
- Existing pilot 26 players, 2026 Weeks 3–6: limited and biased; the 75% 6/8 top-two selection was post-hoc exploratory. Never put it on hero as a validated rate.
- Venom screenshot values from user: separate source, Week 7 only, not historical prediction performance and not odds.

## Essential tests
- Parser handles touchdown carry inside 5, target from LOS 4, pass from LOS 4 with air yards 2 (not EZ proxy) and 5 (EZ proxy), no_play exclusion, two-point exclusion, and Week 7 embargo.
- Two incomplete targets from NYG 4 to Michael Wilson are counted as **two goal5 targets and zero TDs**; `drops` must stay null/unknown unless independently charted. (This is an example QA case; not actual included PBP.)
- A Week 7 import must not include Week 7 games in historical statistics.
- Team defensive splits computed by allowing zero-TD games and only previously completed games.
- Weekly roster row with no box score is not automatically an active game participant.
- `scored_anytime = rush_tds + rec_tds > 0` only; passing TDs by QB are excluded.
- Missing data shows unpopulated UI with explanation, not zero or fabricated 2026 entries.
- Duplicate import idempotent; `build_status.json` and data store stay internally consistent on failed import.
- Backend API only returns probabilities with `calibrated:true` and model version after threshold passed; no false numeric placeholder.
