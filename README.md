# Fourth & Goal Analytics

A local-first NFL anytime-touchdown research app. It ranks every eligible QB, RB, WR and TE for the week using transparent opportunity evidence, explores all 32 defenses, keeps an auditable Top 3 shortlist with immutable pregame locks, and shows a chronologically correct walk-forward backtest. Probabilities appear only after a model has beaten baselines on unseen weeks.

This is football research, not betting advice. No pick is guaranteed.

- **Backend:** Python 3.11+, FastAPI, SQLite, pandas, scikit-learn. The importer is a separate CLI worker (`python -m engine.cli`) that the API runs as a background subprocess.
- **Frontend:** React 18 + TypeScript + Vite, Tailwind with shadcn-style components, TanStack Table and Query, Recharts, lucide icons. Dark and light themes.

## Quick start

```bash
# 1. Backend
cd backend
pip install -r requirements.txt
python -m engine.cli all --download   # downloads the nflverse CSVs into data/raw/, imports, builds, validates, predicts (~1-2 min)
uvicorn main:app --reload             # http://127.0.0.1:8000  (API docs at /docs)

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev                           # http://localhost:5173 (proxies /api to :8000)
```

Or run both with `./dev.sh` from the repo root. For a single-origin build: `cd frontend && npm run build`, then the API serves `frontend/dist` at http://127.0.0.1:8000.

**Offline / manual files:** put the CSVs in `data/raw/` with the local names shown on the Data & Sync page (`pbp_2026.csv`, `stats_2026.csv`, `roster_2026.csv`, ...) and run `python -m engine.cli all` without `--download`. You can also trigger the import from the Data & Sync page.

Environment variables: `FG_DATA_DIR` (default `./data`), `FG_DB`, `FG_RAW_DIR`, `FG_ADMIN_TOKEN` (require a token for `POST /api/data/refresh` if you ever share the server), `FG_CORS`.

## Checks

```bash
cd backend && python -m pytest -q          # 12 tests: parser invariants + synthetic end-to-end
cd backend && python -m engine.cli smoke-test
cd frontend && npm run typecheck && npm test && npm run build
```

## Pages

| Route | Page |
|---|---|
| `/` | Weekly overview: Top Three watchlist, model/data status, matchup strip with market-implied totals, scoring-area volume leaders, defense vulnerabilities, walk-forward performance |
| `/rankings` | All eligible players. Server-side sort, filter, paging; column toggles; pin up to 3; CSV export; expandable "why ranked here"; card layout on mobile |
| `/parlay` | Top 3 builder: evidence rules, exclude and replace, pinned legs, manual American/decimal odds with implied probability, independence product clearly marked simplistic, immutable locks with later grading, CSV export |
| `/defenses`, `/defenses/:team` | All 32 defenses by position (season / last 6 / last 3), xTD allowed, red-zone drive TD rate, pace faced, two-team compare, every TD allowed |
| `/players/:id` | Identity and game, weekly inside-5/10 carries and red-zone targets chart with xTD, field-position split, game log, scoring-chance ledger (misses labelled as missed opportunities, end-zone target proxy labelled as a proxy), opponent history |
| `/backtest` | Walk-forward metrics vs baselines, promotion gate checklist, calibration plot + table, weekly top-3 hits, per position/season, frozen weekly picks, segregated PILOT section |
| `/data` | Source files with rows, SHA-256, import and file timestamps, quality gates, background import with live log, `build_status.json`, licensing and method limits |
| `/settings` | Theme, manual Venom snapshot import (one week only) |

Season and week live in the URL (`?season=2026&week=7`) so every view is linkable, and switching weeks is cached by TanStack Query.

## How the numbers are made

1. **Import (idempotent).** Each file is hashed; an unchanged file is skipped. A changed file is imported in one transaction (delete season + insert + `sources` row), so a failed import leaves the previous data and status intact.
2. **Play xTD.** Run/pass by yards-to-goal bucket (and end-zone proxy for passes), smoothed toward the family rate. Rates for season S are learned only from seasons before S.
3. **Ledger.** `player_game` joins box scores (zero-TD games included), play-by-play opportunity counts and snap counts. Participation = box-score row, offensive snaps, or a counted play. A roster row alone is not participation. Passing TDs never count as anytime TDs.
4. **Pregame features.** For week N, every feature uses games before N only: weighted last-8-game usage, xTD share, red-zone volume, snap share, shrunk TD-game rate, market-implied team total, and opponent position TDs/xTD allowed recomputed at that week's cutoff.
5. **Models.** `fg-structural-1` (team TD expectation from the implied total, times shrunk player xTD share, times opponent adjustment, Poisson link, isotonic calibration), `fg-logit-1` (logistic regression) and `fg-gbm-1` (gradient boosting). Baselines: position rate, shrunk player TD rate, opportunity volume (rank only).
6. **Walk-forward + gate.** Each test week is predicted from models fit only on earlier player-games. A candidate is promoted only if, on unseen weeks, it beats both probability baselines on Brier and log loss, the week-bootstrap 95% CI of the log-loss gain excludes zero, ECE ≤ 0.025, there are ≥ 2,000 test rows and ≥ 10 weeks, and it is not worse than the baseline on the latest season. The simplest passing model within 0.001 log loss of the best wins. If none pass, the API returns `p_model: null` everywhere and the UI shows research scores (percentiles) instead.

### Result of the current run (real nflverse data, imported 2026-10-21)

Test weeks: 2025 W1–W18 and 2026 W1–W6 (24 weeks, 8,940 player-games, TD base rate 16.3%).

| Model | Brier | Log loss | AUC | ECE |
|---|---|---|---|---|
| **fg-logit-1 (promoted)** | 0.1197 | 0.3868 | 0.755 | 0.006 |
| fg-gbm-1 | 0.1197 | 0.3867 | 0.756 | 0.009 |
| fg-structural-1 | 0.1222 | 0.3967 | 0.728 | 0.008 |
| Baseline: shrunk player rate | 0.1257 | 0.4088 | 0.704 | 0.012 |
| Baseline: position rate | 0.1354 | 0.4410 | 0.566 | 0.005 |

Top-3 by the promoted model: 47 of 72 picks scored (65%, Wilson 95% CI 54–75%). With the Top 3 evidence rules (one leg per game, no Questionable/Doubtful), all three legs scored in 8 of 24 weeks (33%). The calibration curve is thin above 60%: only 111 of 8,940 test predictions were that high, and they ran a few points hot, so the UI warns on any leg at 70% or more.

## Data honesty rules enforced in code

- End-zone target = `air_yards >= yardline_100`, always shown as **End-zone target proxy**.
- An incomplete or caught-but-short target is a *missed scoring opportunity*; there is no drop field anywhere.
- Unknown values render as "—"/"unavailable" and sort last; they are never zero-filled into ranks.
- The 26-player pilot lives only in `pilot_*` tables and the PILOT section of the Backtest page.
- Venom values are stored with their season/week and only joined to that week. Venom Score is shown as a ranking number, never as a probability.
- Locks are protected by SQLite triggers that reject UPDATE and DELETE, and are refused after kickoff.

## Corrections made to the handoff engine

`legacy/handoff_backend_existing/` keeps the original files unchanged. The new engine fixes:

1. The week embargo was hard-coded to season 2026.
2. Receiver/rusher TD credit now requires `td_player_id` to match (a teammate's fumble-recovery TD after a catch is not the receiver's TD).
3. `datetime("now")` and `kind="pbp"` used double-quoted string literals, which fail on SQLite builds without DQS.
4. A cached file was trusted by size alone; files are now hashed and re-imported only when changed, atomically.
5. Defense "last 6" was computed only at the import cutoff; splits are now recomputed at every historical week's cutoff.
6. `game_id`, drives, offensive play counts, snaps, injuries and schedule lines were dropped; they are now kept for red-zone drive rates, pace, participation and implied totals.
7. A season-to-date games count was capped by the recency window, which wrongly flagged players as missing games late in the season (found and fixed during this build).

## Known gaps

- **Coverage (man/zone, Cover 1–4):** no charting source is connected; the app says so rather than showing numbers.
- **Injury reports for the upcoming week** are published through the week. For Week 7 only the Thursday game had a report at import time, so most candidates carry an "injury report not yet published" flag. Re-run the import before kickoff.
- **Market lines** come from the nflverse schedule (closing lines for completed games). Backtests therefore use lines slightly later than a midweek decision.
- **Historical archived anytime-TD odds** are not available, so there is no market baseline in the backtest; manually entered odds are informational only.
- Players with snaps but no box-score row count as zero-TD participants; players with neither are treated as did-not-play (void).

Data: nflverse (nflfastR / nflreadr), https://github.com/nflverse/nflverse-data. Review its licence before redistributing data.
