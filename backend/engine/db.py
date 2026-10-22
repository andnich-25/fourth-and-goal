"""SQLite schema for imported sources, derived aggregates, model runs and audit tables."""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources(
  kind TEXT, season INT, filename TEXT, source_url TEXT, sha256 TEXT, file_bytes INT,
  file_mtime TEXT, rows_imported INT, imported_at TEXT, status TEXT, message TEXT,
  PRIMARY KEY(kind, season)
);

-- One row per counted rush or target event (not every play; raw CSV stays on disk).
CREATE TABLE IF NOT EXISTS pbp_events(
  season INT, week INT, game_id TEXT, play_id TEXT, offense TEXT, defense TEXT,
  event_type TEXT, player_id TEXT, player_name TEXT, position TEXT, yards_to_goal REAL,
  air_yards REAL, completed INT, td INT, ez_proxy INT, qb_scramble INT, description TEXT,
  xtd REAL,
  PRIMARY KEY(season, game_id, play_id, event_type, player_id)
);
CREATE INDEX IF NOT EXISTS idx_ev_time ON pbp_events(season, week);
CREATE INDEX IF NOT EXISTS idx_ev_player ON pbp_events(player_id, season, week);
CREATE INDEX IF NOT EXISTS idx_ev_def ON pbp_events(season, week, defense);

CREATE TABLE IF NOT EXISTS drives(
  season INT, week INT, game_id TEXT, offense TEXT, defense TEXT, drive_id TEXT,
  plays INT, inside20 INT, result TEXT, td INT,
  PRIMARY KEY(season, game_id, offense, drive_id)
);
CREATE INDEX IF NOT EXISTS idx_drives_time ON drives(season, week);

CREATE TABLE IF NOT EXISTS team_plays(
  season INT, week INT, game_id TEXT, offense TEXT, plays INT, seconds REAL,
  PRIMARY KEY(season, game_id, offense)
);

CREATE TABLE IF NOT EXISTS player_week(
  season INT, week INT, game_id TEXT, player_id TEXT, player_name TEXT, position TEXT,
  team TEXT, opponent TEXT, carries INT, targets INT, receptions INT, rush_tds INT,
  rec_tds INT, pass_tds INT, rush_yards REAL, rec_yards REAL, headshot_url TEXT,
  completions INT, attempts INT, pass_yards REAL, interceptions INT, sacks REAL,
  PRIMARY KEY(season, week, player_id, team)
);
CREATE INDEX IF NOT EXISTS idx_pw_player ON player_week(player_id, season, week);

CREATE TABLE IF NOT EXISTS roster_week(
  season INT, week INT, player_id TEXT, player_name TEXT, position TEXT, depth_position TEXT,
  team TEXT, status TEXT, pfr_id TEXT, headshot_url TEXT,
  PRIMARY KEY(season, week, player_id, team)
);
CREATE INDEX IF NOT EXISTS idx_roster_team ON roster_week(season, week, team);
CREATE INDEX IF NOT EXISTS idx_roster_pfr ON roster_week(pfr_id);

CREATE TABLE IF NOT EXISTS injuries(
  season INT, week INT, team TEXT, player_id TEXT, player_name TEXT, position TEXT,
  report_status TEXT, practice_status TEXT, injury TEXT,
  PRIMARY KEY(season, week, team, player_id)
);

CREATE TABLE IF NOT EXISTS snaps(
  season INT, week INT, game_id TEXT, team TEXT, pfr_player_id TEXT, player_name TEXT,
  position TEXT, offense_snaps INT, offense_pct REAL,
  PRIMARY KEY(season, game_id, team, pfr_player_id)
);

CREATE TABLE IF NOT EXISTS games(
  game_id TEXT PRIMARY KEY, season INT, game_type TEXT, week INT, gameday TEXT, gametime TEXT,
  away_team TEXT, home_team TEXT, away_score INT, home_score INT, spread_line REAL,
  total_line REAL, roof TEXT
);
CREATE INDEX IF NOT EXISTS idx_games_week ON games(season, week);

-- Derived ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xtd_rates(
  target_season INT, event_type TEXT, bucket TEXT, flag TEXT, touchdowns INT,
  opportunities INT, smoothed_rate REAL, train_seasons TEXT,
  PRIMARY KEY(target_season, event_type, bucket, flag)
);

CREATE TABLE IF NOT EXISTS player_game(
  season INT, week INT, game_id TEXT, player_id TEXT, player_name TEXT, position TEXT,
  team TEXT, opponent TEXT, participated INT, has_box INT, offense_snaps INT, offense_pct REAL,
  carries INT, targets INT, receptions INT, rush_tds INT, rec_tds INT, anytime_tds INT,
  scored_anytime INT, goal5_carries INT, goal10_carries INT, rz_carries INT,
  goal5_targets INT, goal10_targets INT, rz_targets INT, ez_target_proxy INT,
  missed_rz_targets INT, missed_goal5_carries INT, xtd REAL, opportunities INT,
  PRIMARY KEY(season, week, player_id, team)
);
CREATE INDEX IF NOT EXISTS idx_pg_player ON player_game(player_id, season, week);
CREATE INDEX IF NOT EXISTS idx_pg_team ON player_game(season, week, team);

CREATE TABLE IF NOT EXISTS team_game(
  season INT, week INT, game_id TEXT, team TEXT, opponent TEXT, is_home INT,
  points INT, offensive_tds INT, rush_tds INT, rec_tds INT, xtd REAL, opportunities INT,
  plays INT, seconds REAL, drives INT, rz_trips INT, rz_td_drives INT, implied_total REAL,
  PRIMARY KEY(season, week, team)
);

CREATE TABLE IF NOT EXISTS def_pos_game(
  season INT, week INT, game_id TEXT, defense TEXT, opponent TEXT, position TEXT,
  touchdowns INT, xtd REAL, opportunities INT, goal5_carries INT, goal10_carries INT,
  rz_carries INT, goal5_targets INT, goal10_targets INT, rz_targets INT, ez_target_proxy INT,
  rush_tds INT, rec_tds INT,
  PRIMARY KEY(season, week, defense, position)
);

CREATE TABLE IF NOT EXISTS builds(
  build_id TEXT PRIMARY KEY, created_at TEXT, engine_version TEXT, season INT,
  prediction_week INT, status TEXT, summary TEXT
);

CREATE TABLE IF NOT EXISTS model_runs(
  run_id TEXT PRIMARY KEY, kind TEXT, model_version TEXT, created_at TEXT, season INT,
  week INT, data_cutoff TEXT, build_id TEXT, params TEXT, metrics TEXT, gate TEXT,
  promoted INT, calibrated INT
);

CREATE TABLE IF NOT EXISTS predictions(
  run_id TEXT, season INT, week INT, game_id TEXT, player_id TEXT, player_name TEXT,
  position TEXT, team TEXT, opponent TEXT, eligible INT, exclusion TEXT, flags TEXT,
  features TEXT, lam REAL, p_model REAL, score REAL, rank INT, confidence TEXT,
  outcome INT, participated INT,
  PRIMARY KEY(run_id, player_id, team)
);
CREATE INDEX IF NOT EXISTS idx_pred_week ON predictions(run_id, season, week, rank);

CREATE TABLE IF NOT EXISTS backtest_preds(
  run_id TEXT, model TEXT, season INT, week INT, player_id TEXT, team TEXT, position TEXT,
  player_name TEXT, p REAL, score REAL, outcome INT, pregame_eligible INT,
  PRIMARY KEY(run_id, model, season, week, player_id, team)
);
CREATE INDEX IF NOT EXISTS idx_btp ON backtest_preds(run_id, model, season, week);

CREATE TABLE IF NOT EXISTS prop_runs(
  run_id TEXT PRIMARY KEY, kind TEXT, created_at TEXT, report TEXT, parent_run TEXT
);
CREATE TABLE IF NOT EXISTS prop_backtest(
  run_id TEXT, market TEXT, model TEXT, season INT, week INT, player_id TEXT, player_name TEXT, team TEXT,
  position TEXT, mean REAL, median REAL, line REAL, p_over REAL, actual REAL,
  PRIMARY KEY(run_id, market, model, season, week, player_id, team)
);
CREATE TABLE IF NOT EXISTS prop_projections(
  run_id TEXT, market TEXT, season INT, week INT, player_id TEXT, player_name TEXT, team TEXT, opponent TEXT,
  position TEXT, game_id TEXT, eligible INT, exclusion TEXT, flags TEXT, model TEXT, calibrated INT, mean REAL,
  median REAL, q10 REAL, q90 REAL, dist TEXT, evidence TEXT, actual REAL,
  PRIMARY KEY(run_id, market, player_id, team)
);
CREATE INDEX IF NOT EXISTS idx_propproj ON prop_projections(season, week, market);
CREATE TABLE IF NOT EXISTS sim_runs(run_id TEXT PRIMARY KEY, kind TEXT, created_at TEXT, report TEXT);

-- Audit / user data ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS top3_locks(
  lock_id TEXT PRIMARY KEY, created_at TEXT, season INT, week INT, run_id TEXT,
  model_version TEXT, calibrated INT, data_cutoff TEXT, legs TEXT, note TEXT
);
CREATE TRIGGER IF NOT EXISTS top3_locks_no_update BEFORE UPDATE ON top3_locks
BEGIN SELECT RAISE(ABORT, 'locked selections are immutable'); END;
CREATE TRIGGER IF NOT EXISTS top3_locks_no_delete BEFORE DELETE ON top3_locks
BEGIN SELECT RAISE(ABORT, 'locked selections are immutable'); END;


CREATE TABLE IF NOT EXISTS jobs(
  job_id TEXT PRIMARY KEY, kind TEXT, status TEXT, created_at TEXT, started_at TEXT,
  finished_at TEXT, args TEXT, log TEXT, error TEXT
);

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
"""


def connect(path: str | Path) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(path), timeout=30, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.execute("PRAGMA foreign_keys=ON")
    c.executescript(SCHEMA)
    _migrate(c)
    return c


# Columns added after the first release, with the source kind that must be re-imported to fill them.
ADDED_COLUMNS = {"player_week": ([("completions", "INT"), ("attempts", "INT"), ("pass_yards", "REAL"),
                                  ("interceptions", "INT"), ("sacks", "REAL")], "stats")}


# Tables from earlier versions that are no longer used.
DROPPED_TABLES = ("venom_observations", "venom_defense_notes", "pilot_player_games", "pilot_walk_forward",
                  "pilot_week7_candidates", "pilot_policy_metrics", "pilot_week7_watchlist")


def _migrate(c: sqlite3.Connection):
    with c:
        for t in DROPPED_TABLES:
            c.execute(f"DROP TABLE IF EXISTS {t}")
    for table, (cols, kind) in ADDED_COLUMNS.items():
        have = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
        missing = [(n, t) for n, t in cols if n not in have]
        if missing:
            with c:
                for n, t in missing:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {n} {t}")
                # Forget the file hashes so the next sync re-imports and fills the new columns.
                c.execute("DELETE FROM sources WHERE kind=?", (kind,))
