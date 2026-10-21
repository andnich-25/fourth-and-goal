export type Reason = { sign: number; text: string };

export type Features = Record<string, number | string | null | undefined> & {
  n_games_cur?: number;
  carries_pg?: number;
  targets_pg?: number;
  rz_carries_pg?: number;
  goal5_carries_pg?: number;
  goal10_carries_pg?: number;
  rz_targets_pg?: number;
  goal10_targets_pg?: number;
  ez_proxy_pg?: number;
  xtd_pg?: number | null;
  td_pg?: number;
  xtd_share?: number | null;
  snap_pct?: number | null;
  team_implied_total?: number | null;
  opp_def_pos_td_pg?: number | null;
  opp_def_pos_td_pg_raw?: number | null;
  opp_def_pos_mult?: number | null;
  opp_def_games?: number | null;
  league_pos_td_pg?: number | null;
  cur_tds?: number;
  cur_xtd?: number;
  report_status?: string | null;
  gameday?: string | null;
  gametime?: string | null;
};

export type RankingRow = {
  rank: number | null;
  player_id: string;
  player_name: string;
  team: string;
  position: string;
  opponent: string | null;
  game_id: string | null;
  gameday?: string | null;
  gametime?: string | null;
  is_home?: number | null;
  eligible: boolean;
  exclusion: string | null;
  score: number | null;
  p_model: number | null;
  confidence: string | null;
  flags: string[];
  reasons: Reason[];
  features: Features;
  outcome: number | null;
  participated: number | null;
};

export type RankingsResponse = {
  season: number;
  week: number;
  run_id: string | null;
  model_version: string | null;
  calibrated: boolean;
  as_of: string | null;
  data_cutoff: string | null;
  total: number;
  page: number;
  page_size: number;
  rows: RankingRow[];
  fields_available: Record<string, boolean>;
  empty_reason?: string | null;
};

export type Leg = {
  player_id: string;
  player_name: string;
  team: string;
  opponent: string;
  position: string;
  game_id: string;
  rank: number;
  score: number;
  p_model: number | null;
  confidence: string;
  flags: string[];
  reasons: Reason[];
  kickoff_utc?: string | null;
  started?: boolean;
};

export type Top3Response = {
  season: number;
  week: number;
  run_id: string | null;
  model_version: string | null;
  calibrated: boolean;
  data_cutoff?: string | null;
  as_of?: string | null;
  legs: Leg[];
  considered?: number;
  passed_rules?: number;
  passed_floor?: number;
  rules: string[];
  joint?: { value: number; method: string; note: string } | null;
  empty_reason?: string;
  walk_forward_top3_policy?: TopPolicy | null;
};

export type TopPolicy = {
  legs_graded: number;
  leg_hits: number;
  voids: number;
  leg_hit_rate: number | null;
  ci: [number | null, number | null];
  weeks_with_3_legs: number;
  all3_hits: number;
  all3_rate: number | null;
  weeks: number;
  coverage: number | null;
};

export type TopN = { hits: number; graded: number; voids: number; hit_rate: number | null; ci: [number | null, number | null] };

export type ProbMetrics = {
  n: number;
  base_rate: number | null;
  brier: number | null;
  log_loss: number | null;
  auc: number | null;
  ece: number | null;
  calibration?: CalBin[] | null;
};

export type CalBin = { lo: number; hi: number; n: number; mean_pred: number; observed: number; ci: [number | null, number | null] };

export type GateCheck = { check: string; value: unknown; pass: boolean };

export type Gate = {
  promoted: string | null;
  criteria: Record<string, unknown>;
  candidates: Record<string, { passed: boolean; checks: GateCheck[]; log_loss: number }>;
};

export type SourceRow = {
  kind: string;
  season: number | null;
  required: boolean;
  description: string;
  local_file: string;
  local_present: boolean;
  source_url: string;
  status: string;
  rows_imported: number | null;
  imported_at: string | null;
  file_mtime: string | null;
  sha256: string | null;
  file_bytes: number | null;
  message: string | null;
};

export type DataStatus = {
  ready: boolean;
  data_loaded: boolean;
  build_status_present: boolean;
  season: number;
  prediction_week: number;
  current_weeks?: number[];
  gates: { gate: string; value: unknown; threshold: unknown; pass: boolean }[];
  sources: SourceRow[];
  license: string;
  error?: string | null;
  message?: string;
  generated_at?: string;
  latest_completed_gameday?: string | null;
  model?: { promoted: string | null; calibrated: boolean; walk_forward_run: string | null; walk_forward_at: string | null };
  prediction_run?: { run_id: string; model_version: string; calibrated: number; created_at: string; data_cutoff: string } | null;
  coverage_tracking?: string;
  build_status_path?: string;
  [k: string]: unknown;
};

export type Job = {
  job_id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  log: string | null;
  error: string | null;
  args: string;
};
