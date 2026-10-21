# Product requirements: Fourth & Goal Analytics

## 1. Product vision
A professional NFL analytics cockpit that discovers high-quality anytime-TD opportunities, with transparent reasons, real source tracking, league-wide rankings, opponent weakness profiles and trustworthy performance testing. Primary user is a single football-savvy user who wants a clean, usable application. **This is football research, not a wagering execution platform.**

## 2. Key workflows
1. Select season/week (initial 2026 / 7; filter historical games by cutoff). Display source-data freshness and completeness.
2. Identify leading touchdown candidates across ALL 32 teams, not a hand-selected shortlist. Filter by position, game, team, opponent, projection/confidence and red-zone opportunity. Compare candidates and pin up to 3.
3. Investigate each candidate's actual inside-5 runs, inside-10 runs, inside-20 targets, end-zone-target proxy, TDs vs xTD, team usage share, opponent defense's allowed position/field-position TDs, and last games; distinguish actual, forecast, and inferred.
4. Produce and lock a selection of up to three legs with reasons, injury/roster status, matchup and responsible probability display. If insufficient evidence, show fewer than three.
5. Explore any defense by group: positional TDs allowed (QB/RB/WR/TE), xTD allowed, conceded opportunities, scoring-area splits, games sample, allowed red-zone TD rate (when built from actual drive summaries), and man/zone trends (only when separate real coverage data exists).
6. See historical performance by week: model vs simple baselines; top3/top5 hit rates and sample denominators, Brier, log loss and probability reliability chart. Decompose actual TD result vs opportunity signal to learn from near misses.
7. Import updated NFLverse data, manually input a week's Venom snapshot as optional supplementary data, review licensing and source provenance.

## 3. Information architecture

### A. Overview `/`
- Hero: 'Week 7 · 2026 | Analytics through Week 6' and 'Sources verified / Sources missing' prominent status.
- Primary: one large **Top Three Watchlist** card with status, score, individual explanation and due-diligence flags.
- Secondary: League matchup strip, score opportunity of the week, defense vulnerability highlights, recent model performance **only if genuine history is populated**, recent data sync.
- Use a real data-empty state if import incomplete; don't masquerade 2026 pilot figures as league-wide.

### B. Player Rankings `/rankings`
- TanStack sortable, searchable, column-toggle and exportable table. Columns: rank, player, team, pos, opponent, game time, opportunities/game, rz opportunities/game, goal5 carries, red-zone targets, xTD/GP, actual TD/GP, defensive pos TDs allowed/game, model calibrated P(TD), data confidence, Venom score (if user entered), last data update.
- Place the primary rank and TD probability in separate fields. Do not use 90.3 Venom Score to claim 90.3% chance. Show sources and timeframe on hover/click.
- Include feature availability indicator per player; sort unavailable values last rather than zero-fill into ranks.

### C. Player Detail `/players/:player_id`
- Three-column desktop: identity/role and game info, opportunity and scoring-area breakdown, opponent impact.
- Chart weekly inside-5 carries, inside-10 carries, red-zone targets, touchdowns, per-week xTD. Field position split (<=5, 6–10, 11–20, 21–40, 41+).
- Scoring-chance event ledger with date, week, play ID, LOS yards-to-goal, rush/target type, air yards, completion, actual TD, play xTD and original description.
- Call missed 5-yard targets **missed scoring opportunities** not drops. End-zone proxy explicitly labeled.
- 'Why ranked here' explanation tied to actual feature values / opponent history; unavailable features shown as unavailable rather than false zero.

### D. Defense Explorer `/defenses`
- All 32 defense cards and compare switch. Allow per-pos allowed TDs and xTD over sample of prior six played games, recent 3, full season.
- Opponent red-zone TD rate = red-zone DRIVE trips conceded that ended in a TD, not a percentage of red-zone plays. Calculate only when drive data exists.
- If man/zone/Cover 1–4 data unavailable, show 'coverage tracking not connected' and do not invent percentages.
- Use actual completed games prior to selected prediction week for all splits.

### E. Top Three `/parlay`
- Up to 3 best-supported legs; optional replace or exclude player. User can save/later compare locked slate.
- Each leg displays opportunity profile, matchup profile, estimated P(TD) if calibrated, data confidence, manual market odds, and source time.
- Bet odds optional and purely informational; any 3-leg probability must note unmodeled dependencies. Avoid guaranteed wording, stakes and 'lock' language except 'lock picks' (freezes a prediction snapshot for audit).
- Store prediction snapshot (season, week, kickoff, selected IDs, model version, data cutoff, timestamp, predicted chance, actual later). Do not modify past snapshots.

### F. Backtest `/backtest`
- Time-ordered walk-forward report per game/week, reproducible run ID, models against baselines, eligible population, exclusion logic, weekly candidate lists and realized touchdowns.
- Key: hit rate top3/top5, sample size & binomial interval, Brier score, log loss, calibration plot / ECE, AUC where applicable, and 3-leg all-hit fraction.
- Omit pilot 50–75% historical examples from professional performance KPIs unless clearly segregated as 'biased 26-player pilot'.

### G. Data & Settings `/data`
- Import current NFLverse release files, progress, validation, archive, source URLs, missing-file reasons, per-season import counts, week coverage, `build_status.json`.
- Manual Venom screenshot-derived data upload / CSV importer (no private API assumed).
- Player availability and odds fields should be manual/imported until verified integrations exist.
- Data source list with raw/source as-of vs effective game cutoff. Public attribution for NFLverse.

## 4. Visual directions
- Original brand name: Fourth & Goal Analytics. Use dark slate `#0B1018`, elevated surfaces `#141E29`, muted `#93A2B4`, lime/emerald highlights `#9BE15D` (accessible contrasts), white `#F4F7FA` for text. Light mode neutral off-white.
- Premium modern sports research vibe, minimalist—not a neon-saturated betting promotion. Large data typography, readable tables, tidy empty/loading states. Tiny icons, purposeful hover states, 12–16px grid spacing, 12px radius. Team badges with initials if logos unavailable/licensing unclear.
- Mobile: one-column cards for rankings with expandable detail, bottom nav or collapsible sidebar; avoid sideways overflowing giant tables.

## 5. Nonfunctional requirements
- Local-first; backend loads CSV into indexed SQLite; frontend paginates and filters without reprocessing tens of thousands of rows every click.
- TypeScript validation plus Pydantic response types, Python test suite, good error handling, no dangerous shell interpolation of user file paths.
- Fresh data before kickoff and immutable historical snapshots; all timestamps in ISO 8601; show America/Chicago local display.
- Accessibility: keyboard navigation, focus ring, accessible chart alternatives, contrast, no meaning conveyed by color alone.
- Required launch instruction: `cd frontend && npm install && npm run dev` and `cd backend && pip install -r requirements.txt && uvicorn main:app --reload` or equivalent root command.
