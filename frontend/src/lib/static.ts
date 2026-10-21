/* Static-site mode (VITE_STATIC=1): reads the JSON files written by `python -m engine.export_static`
   instead of calling the API. Filtering, sorting, paging and Top 3 exclusions run here in the browser,
   using only values the API already returned. Locks are saved in this browser's local storage. */
import type { Leg, RankingRow, RankingsResponse, Top3Response } from "./types";

export type Params = Record<string, string | number | boolean | null | undefined | (string | number)[]>;

const KEY_PARAMS = ["season", "week", "window", "model"] as const;
const BASE = `${import.meta.env.BASE_URL}data/`;
const LOCKS_KEY = "fg-locks-v1";
const JOINT_NOTE = "Simplistic independence product of the individual validated estimates. It ignores correlation between legs " +
  "(game script, weather, shared scoring environment) and was not separately validated as a parlay probability.";

export class StaticError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Must match key() in backend/engine/export_static.py. */
export function staticKey(path: string, params: Params = {}): string {
  const parts = KEY_PARAMS.filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "").map((k) => `${k}-${params[k]}`);
  return path.replace(/^\/+|\/+$/g, "") + (parts.length ? `/${parts.join("_")}` : "/index") + ".json";
}

const cache = new Map<string, Promise<unknown>>();

async function load<T>(path: string, params: Params = {}): Promise<T> {
  const url = BASE + staticKey(path, params);
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then(async (r) => {
      // GitHub Pages serves a missing file as the HTML 404 page, so check the content type too.
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) {
        cache.delete(url);
        throw new StaticError(404, notPublished(path));
      }
      return r.json();
    }));
  }
  return cache.get(url) as Promise<T>;
}

function notPublished(path: string): string {
  if (path.startsWith("/players/")) return "The website publishes player pages for the latest week only. Switch to the latest week, or use the desktop app for older weeks.";
  return "This view is not included in the published website data.";
}

async function defaults(params: Params): Promise<Params> {
  if (params.season && params.week) return params;
  const w = await load<{ current_season: number; current_week: number }>("/weeks");
  return { ...params, season: params.season ?? w.current_season, week: params.week ?? w.current_week };
}

function list(v: Params[string]): string[] {
  return v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
}

const COLUMN_SORTS = new Set(["rank", "score", "p_model", "player_name", "team", "position", "opponent"]);

function sortValue(r: RankingRow, sort: string): string | number | null {
  const v = COLUMN_SORTS.has(sort) ? (r as unknown as Record<string, unknown>)[sort] : (r.features as Record<string, unknown>)[sort];
  return typeof v === "number" || typeof v === "string" ? v : null;
}

async function rankings(params: Params): Promise<RankingsResponse> {
  const p = await defaults(params);
  const all = await load<RankingsResponse>("/rankings", { season: p.season, week: p.week });
  const positions = list(p.position).map((x) => x.toUpperCase());
  const search = String(p.search ?? "").toLowerCase();
  const team = p.team ? String(p.team) : "";
  const eligibleOnly = p.eligible_only !== false && p.eligible_only !== "false";
  let sort = String(p.sort ?? "rank");
  if (sort === "p_model" && !all.calibrated) sort = "rank";
  const desc = p.order === "desc";
  const rows = all.rows.filter((r) =>
    (!positions.length || positions.includes(r.position)) &&
    (!team || r.team === team || r.opponent === team) &&
    (!search || r.player_name.toLowerCase().includes(search)) &&
    (!eligibleOnly || r.eligible));
  // Unavailable values sort last instead of being treated as zero; ties fall back to rank.
  const byRank = (a: RankingRow, b: RankingRow) => (a.rank ?? Infinity) - (b.rank ?? Infinity);
  rows.sort((a, b) => {
    const x = sortValue(a, sort), y = sortValue(b, sort);
    if (x === null || y === null) return x === y ? byRank(a, b) : x === null ? 1 : -1;
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return (desc ? -c : c) || byRank(a, b);
  });
  const page = Number(p.page ?? 1), size = Number(p.page_size ?? 50);
  return { ...all, total: rows.length, page, page_size: size, rows: rows.slice((page - 1) * size, page * size),
    fields_available: { ...all.fields_available } };
}

async function weeklyTop3(params: Params): Promise<Top3Response & { alternates?: Leg[] }> {
  const p = await defaults(params);
  const base = await load<Top3Response & { alternates?: Leg[] }>("/weekly-top3", { season: p.season, week: p.week });
  const exclude = new Set(list(p.exclude));
  if (!exclude.size || !base.alternates) return base;
  // Same selection as the server: walk the ordered rule-passing pool, one leg per game.
  const legs: Leg[] = [], games = new Set<string>();
  for (const a of base.alternates) {
    if (exclude.has(a.player_id) || games.has(a.game_id)) continue;
    legs.push({ ...a, started: !!a.kickoff_utc && new Date(a.kickoff_utc) <= new Date() });
    games.add(a.game_id);
    if (legs.length === 3) break;
  }
  const joint = base.calibrated && legs.length && legs.every((l) => l.p_model != null)
    ? { value: legs.reduce((x, l) => x * (l.p_model as number), 1), method: "independence product", note: base.joint?.note ?? JOINT_NOTE }
    : null;
  return { ...base, legs, joint };
}

/* ---------- Locks (this browser only) ---------- */

type StoredLock = { lock_id: string; created_at: string; season: number; week: number; run_id: string | null; model_version: string | null;
  calibrated: boolean; data_cutoff: string | null; note: string | null; legs: Record<string, unknown>[] };

function readLocks(): StoredLock[] {
  try { return JSON.parse(localStorage.getItem(LOCKS_KEY) || "[]"); } catch { return []; }
}

/** Kickoff in America/New_York (nflverse gameday + gametime) to a UTC ISO string. */
export function easternToUtc(gameday?: string | null, gametime?: string | null): string | null {
  if (!gameday) return null;
  const [y, m, d] = gameday.split("-").map(Number);
  const [hh, mm] = (gametime || "13:00").split(":").map(Number);
  if ([y, m, d, hh, mm].some((n) => Number.isNaN(n))) return null;
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess + (guess - shown)).toISOString();
}

function impliedProbability(odds: string | null, fmt: string | null): number | null {
  if (!odds) return null;
  const v = Number(String(odds).trim().replace(/^\+/, ""));
  if (!Number.isFinite(v)) return null;
  if (fmt === "decimal") return v > 1 ? 1 / v : null;
  if (Math.abs(v) < 100) return null;
  return v > 0 ? 100 / (v + 100) : -v / (-v + 100);
}

type LockBody = { season: number; week: number; note: string | null; legs: { player_id: string; team: string; odds: string | null; odds_format: string | null }[] };

async function lock(body: LockBody) {
  const all = await load<RankingsResponse>("/rankings", { season: body.season, week: body.week });
  if (!all.run_id) throw new StaticError(409, "No prediction run exists for that week.");
  if (new Set(body.legs.map((l) => l.player_id)).size !== body.legs.length) throw new StaticError(422, "Duplicate player in selection.");
  const games = new Set<string>(), now = new Date();
  const legs = body.legs.map((l) => {
    const p = all.rows.find((r) => r.player_id === l.player_id && r.team === l.team);
    if (!p) throw new StaticError(422, `${l.player_id} is not in the ${body.season} Week ${body.week} candidate pool.`);
    if (!p.eligible) throw new StaticError(422, `${p.player_name} is not eligible: ${p.exclusion}`);
    const ko = easternToUtc(p.gameday, p.gametime);
    if (!ko || new Date(ko) <= now) throw new StaticError(409, `${p.player_name}'s game has started or has no kickoff time; locks are pregame only.`);
    if (p.game_id && games.has(p.game_id)) throw new StaticError(422, "Two legs from the same game: same-game outcomes are correlated, pick one per game.");
    if (p.game_id) games.add(p.game_id);
    const implied = impliedProbability(l.odds, l.odds_format);
    const pm = all.calibrated ? p.p_model : null;
    return { player_id: p.player_id, player_name: p.player_name, team: p.team, opponent: p.opponent, position: p.position, game_id: p.game_id,
      kickoff_utc: ko, rank: p.rank, score: p.score, p_model: pm, confidence: p.confidence, flags: p.flags, reasons: p.reasons,
      odds_input: l.odds, odds_format: l.odds_format, implied_market_prob: implied,
      edge_vs_market: pm != null && implied != null ? pm - implied : null };
  });
  const lk: StoredLock = { lock_id: "lock-" + crypto.randomUUID().replace(/-/g, "").slice(0, 10), created_at: now.toISOString(),
    season: body.season, week: body.week, run_id: all.run_id, model_version: all.model_version, calibrated: all.calibrated,
    data_cutoff: all.data_cutoff, note: body.note, legs };
  // Append-only: existing locks are never rewritten.
  localStorage.setItem(LOCKS_KEY, JSON.stringify([...readLocks(), Object.freeze(lk)]));
  return { lock_id: lk.lock_id, legs };
}

async function audit(lk: StoredLock) {
  let rows: RankingRow[] = [];
  try { rows = (await load<RankingsResponse>("/rankings", { season: lk.season, week: lk.week })).rows; } catch { /* week not published */ }
  const legs = lk.legs.map((l) => {
    const r = rows.find((x) => x.player_id === l.player_id);
    const result = !r || r.outcome === null ? "pending" : !r.participated ? "void (did not play)" : r.outcome ? "hit" : "miss";
    return { ...l, result, touchdowns: null };
  });
  const results = legs.map((l) => l.result);
  return { ...lk, legs, summary: { hits: results.filter((r) => r === "hit").length, misses: results.filter((r) => r === "miss").length,
    pending: results.filter((r) => r === "pending").length, voids: results.filter((r) => r.startsWith("void")).length,
    all_hit: results.length && !results.includes("pending") ? results.every((r) => r === "hit") : null } };
}

async function locks(params: Params) {
  const ls = readLocks().filter((l) => !params.season || l.season === Number(params.season))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return Promise.all(ls.map(audit));
}

/* ---------- CSV exports built in the browser ---------- */

function csv(rows: unknown[][]): string {
  return rows.map((r) => r.map((v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n") + "\n";
}

function save(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function staticDownload(path: string, params: Params = {}) {
  if (path === "/export/rankings.csv") {
    const p = await defaults(params);
    const d = await load<RankingsResponse>("/rankings", { season: p.season, week: p.week });
    const head = ["rank", "player", "team", "position", "opponent", "eligible", "exclusion", "research_score", "validated_p_anytime_td",
      "confidence", "flags", "rz_carries_pg", "goal5_carries_pg", "rz_targets_pg", "ez_target_proxy_pg", "xtd_pg", "xtd_share",
      "team_implied_total", "opp_def_pos_td_pg", "model_version", "calibrated", "data_cutoff", "run_id", "generated_at"];
    const f = (r: RankingRow, k: string) => (r.features as Record<string, unknown>)[k];
    const body = [...d.rows].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)).map((r) => [r.rank, r.player_name, r.team, r.position,
      r.opponent, r.eligible ? 1 : 0, r.exclusion, r.score, d.calibrated ? r.p_model : "", r.confidence, r.flags.join("; "), f(r, "rz_carries_pg"),
      f(r, "goal5_carries_pg"), f(r, "rz_targets_pg"), f(r, "ez_proxy_pg"), f(r, "xtd_pg"), f(r, "xtd_share"), f(r, "team_implied_total"),
      f(r, "opp_def_pos_td_pg"), d.model_version, d.calibrated ? "True" : "False", d.data_cutoff, d.run_id, d.as_of]);
    save(`fourth-and-goal-rankings-${p.season}-w${p.week}.csv`, csv([head, ...body]));
  } else if (path === "/export/locks.csv") {
    const all = await Promise.all(readLocks().sort((a, b) => a.created_at.localeCompare(b.created_at)).map(audit));
    const head = ["lock_id", "locked_at_utc", "season", "week", "model_version", "calibrated", "data_cutoff", "player", "team", "position",
      "opponent", "kickoff_utc", "rank", "research_score", "validated_p", "odds_input", "implied_market_prob", "result", "touchdowns", "note"];
    const body = all.flatMap((a) => a.legs.map((l) => {
      const x = l as Record<string, unknown>;
      return [a.lock_id, a.created_at, a.season, a.week, a.model_version, a.calibrated ? "True" : "False", a.data_cutoff, x.player_name, x.team,
        x.position, x.opponent, x.kickoff_utc, x.rank, x.score, a.calibrated ? x.p_model : "", x.odds_input, x.implied_market_prob, x.result, "", a.note];
    }));
    save("fourth-and-goal-locked-selections.csv", csv([head, ...body]));
  }
}

/* ---------- Router ---------- */

export async function staticGet<T>(path: string, params: Params = {}): Promise<T> {
  if (path === "/rankings") return rankings(params) as Promise<T>;
  if (path === "/weekly-top3") return weeklyTop3(params) as Promise<T>;
  if (path === "/locks") return locks(params) as Promise<T>;
  if (path === "/data/jobs") return [] as T;
  const needsWeek = path === "/overview" || path === "/defenses" || path.startsWith("/defenses/") || path.startsWith("/players/");
  return load<T>(path, needsWeek ? await defaults(params) : params);
}

export async function staticPost<T>(path: string, body: unknown): Promise<T> {
  if (path === "/weekly-top3/lock") return lock(body as LockBody) as Promise<T>;
  throw new StaticError(405, "The website is read-only. Data refreshes automatically on a schedule, and Venom imports need the desktop app.");
}
