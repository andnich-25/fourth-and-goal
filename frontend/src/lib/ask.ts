/* The "Ask" engine: answers betting questions from the site's own validated numbers. Every chance, line and price
   in an answer comes from the published data (rankings, prop projections, sportsbook feed); nothing is invented.
   The same functions back the optional AI mode, which may only call them as tools. */
import type { Confidence, Tier } from "@/lib/confidence";
import { tierFor } from "@/lib/confidence";
import type { Feed, OddsRow } from "@/lib/feed";
import { feedLine } from "@/lib/feed";
import { pOver, type PropDist } from "@/lib/props";
import { simulate, type Buckets, type SimLeg } from "@/lib/sim";
import type { RankingRow } from "@/lib/types";
import { dueOf, type Due, type DueBin } from "@/lib/signals";
import { likelyToPlay, starterQbs } from "@/lib/playing";

export type Recent = { season: number; week: number; opponent: string; value: number };
export type PropRow = { player_id: string; player_name: string; team: string; opponent: string; position: string; game_id: string; eligible: number;
  median: number; q10: number; q90: number; dist: PropDist | null; recent?: Recent[]; evidence?: Record<string, number | null> };
export type AskData = {
  season: number; week: number; td: RankingRow[]; props: Record<string, { label: string; rows: PropRow[] }>;
  feed: Feed; conf?: Confidence; buckets: Buckets; useCorr: boolean; dueRecord?: DueBin | null;
};
export type Pick = {
  id: string; player_id: string; name: string; team: string; opp: string; pos: string; game_id: string; market: string; label: string;
  p: number; kind: "td" | "props"; side: "yes" | "over" | "under"; line?: number; price?: number; book?: string; edge?: number;
  tier?: string; tierRate?: number | null; tierData?: Tier; note?: string; reasons?: string[]; lineSource?: "book" | "usual"; median?: number; range?: [number, number]; dist?: PropDist; recent?: Recent[]; due?: Due;
};
export type Answer = {
  title: string; summary: string; picks?: Pick[]; groups?: { title: string; picks: Pick[] }[];
  parlay?: { joint: number; independent: number; price?: number; legs: number }; notes: string[]; followups: string[];
  projections?: { name: string; team: string; pos: string; market: string; median: number; range: [number, number] }[];
};

const MIN_EDGE = 0.03;
const RISKY = new Set(["Questionable", "Doubtful", "Out"]);

/* ------------------------------------------------------------------ vocabulary */
export const TEAMS: Record<string, string> = {
  cardinals: "ARI", arizona: "ARI", falcons: "ATL", atlanta: "ATL", ravens: "BAL", baltimore: "BAL", bills: "BUF", buffalo: "BUF",
  panthers: "CAR", carolina: "CAR", bears: "CHI", chicago: "CHI", bengals: "CIN", cincinnati: "CIN", browns: "CLE", cleveland: "CLE",
  cowboys: "DAL", dallas: "DAL", broncos: "DEN", denver: "DEN", lions: "DET", detroit: "DET", packers: "GB", "green bay": "GB",
  texans: "HOU", houston: "HOU", colts: "IND", indianapolis: "IND", jaguars: "JAX", jags: "JAX", jacksonville: "JAX", chiefs: "KC",
  "kansas city": "KC", rams: "LA", chargers: "LAC", raiders: "LV", "las vegas": "LV", vegas: "LV", dolphins: "MIA", miami: "MIA",
  vikings: "MIN", minnesota: "MIN", patriots: "NE", pats: "NE", "new england": "NE", saints: "NO", "new orleans": "NO", giants: "NYG",
  jets: "NYJ", eagles: "PHI", philadelphia: "PHI", philly: "PHI", steelers: "PIT", pittsburgh: "PIT", seahawks: "SEA", seattle: "SEA",
  "49ers": "SF", niners: "SF", "san francisco": "SF", buccaneers: "TB", bucs: "TB", "tampa bay": "TB", tampa: "TB", titans: "TEN",
  tennessee: "TEN", commanders: "WAS", washington: "WAS",
};
const CODES = new Set(Object.values(TEAMS));
const POS: [RegExp, string][] = [
  [/\b(qbs?|quarterbacks?)\b/, "QB"], [/\b(rbs?|running ?backs?|backs|rushers?)\b/, "RB"],
  [/\b(wrs?|wide ?receivers?|receivers?|wideouts?)\b/, "WR"], [/\b(tes?|tight ?ends?)\b/, "TE"],
];
// market -> phrases (longest first matters for overlaps like "rushing + receiving yards")
const MARKET_WORDS: [string, RegExp][] = [
  ["rush_rec_yards", /(rush(ing)?\s*(\+|and|&)\s*rec(eiving)?|scrimmage)\s*(yards|yds)?/],
  ["rec_yards", /(rec(eiving)?|catch(ing)?)\s*(yards|yds|yardage)/],
  ["rush_yards", /(rush(ing)?|run(ning)?|ground)\s*(yards|yds|yardage)/],
  ["pass_yards", /(pass(ing)?|throw(ing)?|air)\s*(yards|yds|yardage)/],
  ["pass_tds", /(pass(ing)?|throw(ing)?)\s*(tds?|touchdowns?)/],
  ["interceptions", /\b(interceptions?|ints?|picks thrown|throw a pick)\b/],
  ["completions", /\bcompletions?\b/],
  ["pass_attempts", /\b(pass(ing)? attempts?|attempts)\b/],
  ["carries", /\b(carries|rush(ing)? attempts?|rushes)\b/],
  ["receptions", /\b(receptions?|catches|recs)\b/],
];
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, single: 1,
  pair: 2, couple: 2, few: 3, handful: 5, dozen: 12 };
const DAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, tnf: 4, mnf: 1, snf: 0 };

/** Market label inside a sentence: lower case, but keep "TDs" as written. */
const lc = (s: string) => s.toLowerCase().replace(/\btds?\b/g, (m) => m.toUpperCase().replace("S", "s"));

export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9+&' ]/g, " ")
  .replace(/'/g, "").replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------ helpers */
const dec = (american: number) => 1 + (american > 0 ? american / 100 : 100 / -american);
const bestOf = (rows: OddsRow[]) => rows.reduce<OddsRow | null>((b, r) => (!b || dec(r.price) > dec(b.price) ? r : b), null);
export const american = (d: number) => (d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`);
export const fmtPrice = (p: number) => (p > 0 ? `+${p}` : String(p));
const pct = (p: number) => `${Math.round(p * 100)}%`;
export const gameTeams = (gid: string) => { const m = gid.split("_"); return { away: m[2] ?? "", home: m[3] ?? "" }; };
export const gameLabel = (gid: string) => { const g = gameTeams(gid); return `${g.away} at ${g.home}`; };
const status = (r: RankingRow) => (r.features?.report_status ? String(r.features.report_status) : "");

function withTier(d: AskData, p: Pick): Pick {
  const t = tierFor(d.conf, p.kind, p.p); // the side is already chosen, so a prop under 50% gets no tier
  return { ...p, tier: t?.tier, tierRate: t?.rate ?? null, tierData: t ?? undefined };
}

export function tdPick(d: AskData, r: RankingRow): Pick {
  const b = bestOf(d.feed.get("td", r.player_id, "yes"));
  const st = status(r);
  return withTier(d, {
    id: `td:${r.player_id}`, player_id: r.player_id, name: r.player_name, team: r.team, opp: r.opponent ?? "", pos: r.position,
    game_id: r.game_id ?? "", market: "td", label: "Anytime TD", p: r.p_model as number, kind: "td", side: "yes",
    price: b?.price, book: b?.book, edge: b ? (r.p_model as number) - 1 / dec(b.price) : undefined,
    note: st ? `Injury report: ${st}` : undefined, due: dueOf(r.features) ?? undefined,
  });
}

function propPick(d: AskData, market: string, r: PropRow, line: number, side: "over" | "under"): Pick {
  const over = pOver(r.dist as PropDist, line);
  const p = side === "over" ? over : 1 - over;
  const b = bestOf(d.feed.get(market, r.player_id, side).filter((x) => x.line === line));
  const label = `${side === "over" ? "Over" : "Under"} ${line} ${lc(d.props[market]?.label ?? market)}`;
  return withTier(d, {
    id: `${market}:${r.player_id}`, player_id: r.player_id, name: r.player_name, team: r.team, opp: r.opponent, pos: r.position, game_id: r.game_id,
    market, label, p, kind: "props", side, line, price: b?.price, book: b?.book, edge: b ? p - 1 / dec(b.price) : undefined,
    median: r.median, range: [r.q10, r.q90], dist: r.dist ?? undefined, recent: r.recent,
  });
}

/* ------------------------------------------------------------------ who plays */
const qbCache = new WeakMap<object, Map<string, string>>();
function qbs(d: AskData) {
  let m = qbCache.get(d.props);
  if (!m) { m = starterQbs(Object.values(d.props).flatMap((x) => x.rows)); qbCache.set(d.props, m); }
  return m;
}
const tdPricedGames = new WeakMap<object, Set<string>>();
function pricedGames(d: AskData) {
  let g = tdPricedGames.get(d.td);
  if (!g) { g = new Set(d.td.filter((r) => r.game_id && d.feed.get("td", r.player_id, "yes").length).map((r) => r.game_id as string)); tdPricedGames.set(d.td, g); }
  return g;
}
/** Projected starter or real role, and (once books have priced his game) listed by at least one book. */
export function plays(d: AskData, r: { player_id: string; team: string; position: string; game_id?: string | null }, snap: unknown, market = "td"): boolean {
  if (!likelyToPlay({ ...r, snap: typeof snap === "number" ? snap : null }, qbs(d))) return false;
  if (market === "td" && d.feed.at && r.game_id && pricedGames(d).has(r.game_id) && !d.feed.get("td", r.player_id, "yes").length) return false;
  return true;
}
const propPlays = (d: AskData, r: PropRow, m: string) => plays(d, r, r.evidence?.snap_pct, m);

/* ------------------------------------------------------------------ filters */
export type Filters = { position?: string; teams?: string[]; teamOnly?: boolean; day?: number; safe?: boolean };

function dayOf(r: { gameday?: string | null }) {
  return r.gameday ? new Date(`${r.gameday}T12:00:00`).getDay() : null;
}
function gameDays(d: AskData): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const r of d.td) if (r.game_id && !m.has(r.game_id)) m.set(r.game_id, dayOf(r));
  return m;
}
function keep(d: AskData, f: Filters, x: { pos: string; team: string; opp: string; game_id: string }, st = "") {
  if (f.position && x.pos !== f.position) return false;
  if (f.teams?.length && !f.teams.some((t) => t === x.team || (!f.teamOnly && t === x.opp))) return false;
  if (f.day != null && gameDays(d).get(x.game_id) !== f.day) return false;
  if (f.safe !== false && RISKY.has(st)) return false;
  return true;
}

export function tdPool(d: AskData, f: Filters = {}): Pick[] {
  return d.td.filter((r) => r.p_model != null && r.game_id && r.eligible !== false && plays(d, r, r.features?.snap_pct))
    .filter((r) => keep(d, f, { pos: r.position, team: r.team, opp: r.opponent ?? "", game_id: r.game_id ?? "" }, status(r)))
    .map((r) => tdPick(d, r)).sort((a, b) => b.p - a.p);
}

/** Every prop leg with a book line (the most common line across books), both sides. */
export function propPool(d: AskData, market: string, f: Filters = {}, side?: "over" | "under", customLine?: number): Pick[] {
  const out: Pick[] = [];
  for (const r of d.props[market]?.rows ?? []) {
    if (!r.eligible || !r.dist || !propPlays(d, r, market)) continue;
    if (!keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id })) continue;
    const line = customLine ?? feedLine(d.feed, market, r.player_id);
    if (line == null) continue;
    for (const s of side ? [side] : (["over", "under"] as const)) out.push(propPick(d, market, r, line, s));
  }
  return out.sort((a, b) => b.p - a.p);
}

/** The single most likely leg for each player across every market: anytime TD plus the likelier side of each prop.
 *  Props use the book line once prices are loaded; before that, the player's usual line (marked as such). */
export function anyPool(d: AskData, f: Filters = {}, markets?: string[]): Pick[] {
  const all: Pick[] = [];
  if (!markets || markets.includes("td")) all.push(...tdPool(d, f));
  const priced = !!d.feed.at;
  for (const m of markets?.filter((x) => x !== "td") ?? Object.keys(d.props)) {
    for (const r of d.props[m]?.rows ?? []) {
      if (!r.eligible || !r.dist || !propPlays(d, r, m)) continue;
      if (!keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id })) continue;
      const book = feedLine(d.feed, m, r.player_id);
      const line = book ?? (priced ? null : usualLine(r, m));
      if (line == null) continue;
      // Books set lines near the projection. A usual line far from this week's projection (a role change, a backup
      // starting) is not a line anyone will offer, so it can't count as a "safe" pick.
      if (book == null && Math.abs(r.median - line) > Math.max(1.5, 0.2 * Math.max(line, r.median))) continue;
      const over = pOver(r.dist, line);
      all.push({ ...propPick(d, m, r, line, over >= 0.5 ? "over" : "under"), lineSource: book != null ? "book" : "usual" });
    }
  }
  const best = new Map<string, Pick>();
  for (const p of all.sort((a, b) => b.p - a.p)) if (!best.has(p.player_id)) best.set(p.player_id, p);
  return [...best.values()];
}

export function answerAny(d: AskData, n: number, f: Filters, noTd = false): Answer {
  const picks = anyPool(d, f, noTd ? Object.keys(d.props) : undefined).slice(0, n);
  if (!picks.length) return none(d, "No picks match that", f);
  const usual = picks.some((p) => p.lineSource === "usual");
  return {
    title: `${picks.length === 1 ? "Safest pick" : `Safest ${picks.length} picks`} across every market${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: `The highest validated chance for each player across ${noTd ? "every prop market (no TDs)" : "anytime TD and every prop market"}, one pick per player.`,
    picks, notes: [
      ...(usual ? ["No book lines are loaded yet, so props are shown at each player's usual line (his recent median, rounded to a half point), and only where that line is close to this week's projection. Books may still set a different line, so check it before betting."] : []),
      ...noteTier(picks), ...priceNote(d)],
    followups: ["Build a 3-leg parlay from these", "Best value bets", "Who will fall short this week?"],
  };
}

/* ------------------------------------------------------------------ answers (also the AI tools) */
const describe = (f: Filters) => [f.position ? `${f.position}s` : "", f.teams?.length ? f.teams.join("/") : "",
  f.day != null ? Object.keys(DAYS).find((k) => DAYS[k] === f.day && k.length > 3) ?? "" : ""].filter(Boolean).join(", ");

function noteTier(picks: Pick[]): string[] {
  return picks.some((p) => p.tier) ? ["Tiers show how often past picks in that range actually hit on unseen weeks (walk-forward, 2021–2026)."] : [];
}
const priceNote = (d: AskData) => (d.feed.at ? [] : ["No sportsbook prices are loaded for this week yet, so value and price comparisons are not available."]);

export function answerTop(d: AskData, n: number, f: Filters): Answer {
  const picks = tdPool(d, f).slice(0, n);
  if (!picks.length) return none(d, "No anytime-TD chances match that", f);
  return {
    title: `Top ${picks.length} anytime TD ${picks.length === 1 ? "pick" : "picks"}${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: `Highest validated chances to score this week${f.safe !== false ? ", leaving out players listed Questionable or worse" : ""}.`,
    picks, notes: [...noteTier(picks), ...priceNote(d)],
    followups: ["Build a 3-leg parlay from these", "Best value TD bets", "One TD scorer from each game"],
  };
}

export function answerPerGame(d: AskData, market: string, f: Filters): Answer {
  const pool = market === "any" ? anyPool(d, f) : market === "any-props" ? anyPool(d, f, Object.keys(d.props)) : market === "td" ? tdPool(d, f) : propPool(d, market, f);
  const byGame = new Map<string, Pick>();
  for (const p of pool) if (!byGame.has(p.game_id)) byGame.set(p.game_id, p);
  const picks = [...byGame.values()].sort((a, b) => b.p - a.p);
  if (!picks.length) return none(d, market === "td" ? "No TD chances for these games" : `No ${(d.props[market] && lc(d.props[market].label)) ?? market} lines yet`, f);
  const sim = simulate(picks.map(toSim), d.buckets, d.useCorr, 20000);
  const what = market === "any" ? "pick (any market)" : market === "any-props" ? "prop (any market, no TDs)" : market === "td" ? "TD scorer" : `${(d.props[market] && lc(d.props[market].label))} pick`;
  return {
    title: `Best ${what} from each game${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: `The single most likely ${market === "td" ? "scorer" : market === "any" ? "leg across TD and every prop market" : market === "any-props" ? "leg across every prop market" : "leg"} in each of ${picks.length} games, strongest first.`,
    picks, notes: [
      `Chance at least ${Math.ceil(picks.length / 2)} of ${picks.length} hit: ${pct(sim.hits.slice(Math.ceil(picks.length / 2)).reduce((a, b) => a + b, 0))}. ` +
      `All ${picks.length} together: ${(sim.joint * 100).toFixed(sim.joint < 0.01 ? 2 : 1)}% (so treat these as single bets, not one parlay).`,
      ...noteTier(picks), ...priceNote(d)],
    followups: ["Top 5 TD scorers", "Best value bets this week", "Safest 3-leg parlay"],
  };
}

export function answerProps(d: AskData, market: string, n: number, f: Filters, side?: "over" | "under", line?: number): Answer {
  const label = d.props[market]?.label ?? market;
  if (!d.props[market]) return { title: label, summary: `${label} has not passed validation, so the site does not give chances for it.`, notes: [], followups: ["Best value bets this week"] };
  const picks = propPool(d, market, f, line != null ? side ?? "over" : side, line);
  const seen = new Set<string>();
  const uniq = picks.filter((p) => (seen.has(p.player_id) ? false : (seen.add(p.player_id), true))).slice(0, n);
  if (!uniq.length) {
    const proj = (d.props[market].rows ?? []).filter((r) => r.eligible && propPlays(d, r, market) && keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id }))
      .sort((a, b) => b.median - a.median).slice(0, n);
    return {
      title: `${label}: projections${describe(f) ? ` (${describe(f)})` : ""}`,
      summary: "No sportsbook lines are loaded for this market yet, so here are the projected medians and 80% ranges. Over/under chances appear once lines arrive (the Saturday price pull), or type a line in the parlay builder.",
      projections: proj.map((r) => ({ name: r.player_name, team: r.team, pos: r.position, market, median: r.median, range: [r.q10, r.q90] })),
      notes: [], followups: ["Best value bets this week", "Top 5 TD scorers"],
    };
  }
  return {
    title: line != null ? `Most likely to go ${side === "under" ? "under" : "over"} ${line} ${lc(label)}${describe(f) ? ` (${describe(f)})` : ""}`
      : `Best ${side ?? "over/under"} ${lc(label)} picks${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: line != null ? `Chance each player clears ${line}, from the validated ${lc(label)} model. Prices are shown only where a book offers that exact line.`
      : `Most likely side at the line most books offer, from the validated ${lc(label)} model.`,
    picks: uniq, notes: [...noteTier(uniq), ...priceNote(d)], followups: [`${label} best value`, "Safest 3-leg parlay", "One TD scorer from each game"],
  };
}

export function answerValue(d: AskData, n: number, f: Filters, markets?: string[]): Answer {
  if (!d.feed.at) return { title: "Best value bets", summary: "Value needs sportsbook prices, and none are loaded for this week yet. They arrive with the Saturday price pull.", notes: [], followups: ["Top 5 TD scorers", "One TD scorer from each game"] };
  const ms = markets ?? ["td", ...Object.keys(d.props)];
  const all = ms.flatMap((m) => (m === "td" ? tdPool(d, f) : propPool(d, m, f))).filter((p) => p.edge != null && p.edge >= MIN_EDGE);
  all.sort((a, b) => (b.edge as number) - (a.edge as number));
  const seen = new Set<string>();
  const picks = all.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).slice(0, n);
  if (!picks.length) return { title: "Best value bets", summary: `No leg${describe(f) ? ` (${describe(f)})` : ""} beats the best sportsbook price by 3 points or more right now. Passing is part of winning: book prices are sharp.`, notes: [], followups: ["Top 5 TD scorers"] };
  return {
    title: `Best value${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: "Where our chance beats the chance implied by the best price at any US book by the widest margin (3 points minimum).",
    picks, notes: ["The implied chance includes the book's margin. An edge is an estimate, not a sure thing; the against-the-books record on the Track record page builds week by week.", ...noteTier(picks)],
    followups: ["Build a value parlay", "Top 5 TD scorers", "One TD scorer from each game"],
  };
}

export function answerParlay(d: AskData, legs: number, f: Filters, opts: { market?: string; value?: boolean; sameGame?: boolean } = {}): Answer {
  const market = opts.market ?? "td";
  let pool = market === "td" ? tdPool(d, f).slice(0, 40) : propPool(d, market, f).filter((p) => p.p >= 0.5);
  if (new Set(pool.map((p) => p.game_id)).size === 1) opts = { ...opts, sameGame: true }; // a single-game slate (e.g. Thursday)
  if (opts.value) pool = pool.filter((p) => p.price != null && (p.edge as number) >= MIN_EDGE);
  const chosen: Pick[] = [];
  let current = opts.value ? 0 : -1;
  for (let k = 0; k < legs; k++) {
    let best: Pick | null = null, bestScore = -Infinity;
    for (const c of pool) {
      if (chosen.some((x) => x.player_id === c.player_id)) continue;
      if (!opts.sameGame && chosen.some((x) => x.game_id === c.game_id)) continue;
      const set = [...chosen, c];
      const p = simulate(set.map(toSim), d.buckets, d.useCorr, 6000, 99).joint;
      const score = opts.value ? p * set.reduce((a, x) => a * dec(x.price as number), 1) - 1 : p;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best || (opts.value && bestScore <= current)) break;
    chosen.push(best);
    current = bestScore;
  }
  if (!chosen.length) return none(d, opts.value ? "No legs beat the best price by 3+ points" : "Not enough legs to build that parlay", f);
  const sim = simulate(chosen.map(toSim), d.buckets, d.useCorr, 40000);
  const priced = chosen.every((p) => p.price != null);
  const price = priced ? chosen.reduce((a, p) => a * dec(p.price as number), 1) : undefined;
  return {
    title: `${opts.value ? "Best value" : "Safest"} ${chosen.length}-leg ${market === "td" ? "TD " : ""}parlay${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: opts.value ? "Built only from legs that beat the best book price, combined for the highest expected return." :
      `The combination most likely to hit, from 40,000 simulated weeks${opts.sameGame ? "" : " (one leg per game)"}.`,
    picks: chosen, parlay: { joint: sim.joint, independent: sim.independent, price, legs: chosen.length },
    notes: [price ? `Best prices multiplied: ${american(price)}, which implies ${pct(1 / price)} vs our ${pct(sim.joint)}.` : "Add prices in the parlay builder to compare against the books.",
      ...noteTier(chosen)],
    followups: ["Open this in the parlay builder", "Best value bets this week", "One TD scorer from each game"],
  };
}

export function answerPlayer(d: AskData, ids: string[], only?: string): Answer {
  const groups: { title: string; picks: Pick[] }[] = [];
  const projections: NonNullable<Answer["projections"]> = [];
  const reasons: string[] = [];
  for (const id of ids) {
    const r = d.td.find((x) => x.player_id === id);
    const picks: Pick[] = [];
    if (r?.p_model != null && (!only || only === "td")) picks.push(tdPick(d, r));
    let name = r?.player_name, team = r?.team, pos = r?.position;
    for (const [m, { rows }] of Object.entries(d.props)) {
      if (only && only !== m) continue;
      const pr = rows.find((x) => x.player_id === id && x.eligible && x.dist);
      if (!pr) continue;
      name ??= pr.player_name; team ??= pr.team; pos ??= pr.position;
      const line = feedLine(d.feed, m, id);
      if (line != null) {
        const o = propPick(d, m, pr, line, "over"), u = propPick(d, m, pr, line, "under");
        picks.push(o.p >= u.p ? o : u);
      } else projections.push({ name: pr.player_name, team: pr.team, pos: pr.position, market: m, median: pr.median, range: [pr.q10, pr.q90] });
    }
    if (r?.reasons?.length && (!only || only === "td")) reasons.push(`${r.player_name}: ${r.reasons.slice(0, 3).map((x) => x.text).join("; ")}.`);
    groups.push({ title: `${name ?? "Player"}${team ? ` (${pos}, ${team}${r?.opponent ? ` vs ${r.opponent}` : ""})` : ""}`, picks });
  }
  const any = groups.some((g) => g.picks.length) || projections.length;
  return {
    title: groups.map((g) => g.title.split(" (")[0]).join(" vs "),
    summary: any ? (ids.length > 1 ? "Side by side: every validated chance we have for each player this week." : "Every validated chance we have for this player this week. For props, the more likely side at the book line is shown.")
      : "No validated chances for this player this week (not eligible, injured, or not enough recent volume).",
    groups, projections: projections.length ? projections : undefined, notes: [...reasons, ...noteTier(groups.flatMap((g) => g.picks)), ...priceNote(d)],
    followups: ["Top 5 TD scorers", "One TD scorer from each game"],
  };
}

export function answerGame(d: AskData, teams: string[], f: Filters): Answer {
  const games = new Map<string, string[]>();
  for (const r of d.td) if (r.game_id && teams.includes(r.team)) games.set(r.game_id, [...new Set([...(games.get(r.game_id) ?? []), r.team])]);
  // Two named teams that meet each other: just that game.
  const shared = [...games].filter(([, t]) => t.length > 1).map(([g]) => g);
  const ids = shared.length ? shared : [...games.keys()];
  if (!ids.length) return none(d, `No chances for ${teams.join("/")} this week`, f);
  const groups: { title: string; picks: Pick[] }[] = [];
  for (const gid of ids) {
    const g = gameTeams(gid);
    const inGame = { ...f, teams: [g.away, g.home], teamOnly: true };
    groups.push({ title: `${gameLabel(gid)}: anytime TD`, picks: tdPool(d, inGame).slice(0, 8) });
    const props = Object.keys(d.props).flatMap((m) => propPool(d, m, inGame).slice(0, 2)).sort((a, b) => b.p - a.p).slice(0, 5);
    if (props.length) groups.push({ title: `${gameLabel(gid)}: props`, picks: props });
  }
  return {
    title: ids.map(gameLabel).join(" · "), summary: `Most likely touchdown scorers${groups.some((x) => x.title.endsWith("props")) ? " and strongest prop sides" : ""}, both teams.`,
    groups, notes: [...noteTier(groups.flatMap((x) => x.picks)), ...priceNote(d)], followups: [`Safest 2-leg same game parlay ${teams[0]}`, "One TD scorer from each game"],
  };
}

export function answerAvoid(d: AskData, n: number, f: Filters): Answer {
  if (!d.feed.at) return { title: "Bets to avoid", summary: "This needs sportsbook prices, and none are loaded for this week yet.", notes: [], followups: ["Top 5 TD scorers"] };
  const picks = ["td", ...Object.keys(d.props)].flatMap((m) => (m === "td" ? tdPool(d, { ...f, safe: false }) : propPool(d, m, f)))
    .filter((p) => p.edge != null && p.edge <= -0.05).sort((a, b) => (a.edge as number) - (b.edge as number)).slice(0, n);
  if (!picks.length) return { title: "Bets to avoid", summary: "No popular bet is priced far above our chance right now.", notes: [], followups: ["Best value bets"] };
  return {
    title: `Overpriced bets to avoid${describe(f) ? ` (${describe(f)})` : ""}`, summary: "Even the best price implies a much higher chance than our model gives: the book is charging too much here.",
    picks, notes: noteTier(picks), followups: ["Best value bets", "Top 5 TD scorers"],
  };
}

/* ------------------------------------------------------------------ unders: where a player falls short */
const STAT: Record<string, string> = { pass_attempts: "attempts" };
const statOf = (m: string) => STAT[m] ?? m;
const POS_NAME: Record<string, string> = { QB: "quarterbacks", RB: "running backs", WR: "receivers", TE: "tight ends" };
const YARDS = new Set(["pass_yards", "rush_yards", "rec_yards", "rush_rec_yards", "pass_tds"]);

/** The usual line for a player: his recent median rounded to a book-style half point (the line the backtest graded). */
export function usualLine(r: PropRow, market: string): number | null {
  const m = r.evidence?.[`${statOf(market)}_med`];
  return m == null ? null : Math.floor(m) + 0.5;
}

/** Plain reasons a player may fall short of a line, strongest first, from pregame data only. */
export function underReasons(r: PropRow, market: string, label: string, line: number): string[] {
  const e = r.evidence ?? {};
  const st = statOf(market);
  const out: { w: number; t: string }[] = [];
  const lab = lc(label);
  const mult = e[`opp_${st}_mult`];
  if (mult != null && mult <= 0.95) out.push({ w: 1 - mult, t: `${r.opponent} allows ${Math.round((1 - mult) * 100)}% fewer ${lab} to ${POS_NAME[r.position] ?? r.position} than average` });
  const rec = r.recent ?? [];
  if (rec.length >= 4) {
    const k = rec.filter((g) => g.value < line).length;
    if (k / rec.length >= 0.6) out.push({ w: (k / rec.length - 0.5), t: `Under ${line} in ${k} of his last ${rec.length} games` });
  }
  const l3 = e[`${st}_l3`];
  if (l3 != null && l3 < line) out.push({ w: Math.min(0.4, (line - l3) / Math.max(line, 1)), t: `Averaging ${num1(l3)} over his last 3 games` });
  const med = e[`${st}_med`];
  if (med != null && med < line - 0.5) out.push({ w: Math.min(0.3, (line - med) / Math.max(line, 1)), t: `His typical game is ${num1(med)}` });
  const tt = e.team_implied_total;
  if (tt != null && tt <= 20 && YARDS.has(market)) out.push({ w: (21 - tt) / 40, t: `Team projected for only ${num1(tt)} points` });
  const share = e.targets_share ?? e.carries_share;
  if (share != null && share < 0.15 && ["rec_yards", "receptions", "rush_yards", "carries", "rush_rec_yards"].includes(market)) out.push({ w: 0.1, t: `Only ${Math.round(share * 100)}% of his team's ${e.targets_share != null ? "targets" : "carries"}` });
  const snap = e.snap_pct;
  if (snap != null && snap < 0.6 && r.position !== "QB") out.push({ w: 0.08, t: `Plays ${Math.round(snap * 100)}% of snaps` });
  return out.sort((a, b) => b.w - a.w).slice(0, 3).map((x) => x.t);
}
/** Plain reasons a player may clear a line, strongest first, from pregame data only. */
export function overReasons(r: PropRow, market: string, label: string, line: number): string[] {
  const e = r.evidence ?? {};
  const st = statOf(market);
  const out: { w: number; t: string }[] = [];
  const mult = e[`opp_${st}_mult`];
  if (mult != null && mult >= 1.05) out.push({ w: mult - 1, t: `${r.opponent} allows ${Math.round((mult - 1) * 100)}% more ${lc(label)} to ${POS_NAME[r.position] ?? r.position} than average` });
  const rec = r.recent ?? [];
  if (rec.length >= 4) {
    const k = rec.filter((g) => g.value > line).length;
    if (k / rec.length >= 0.6) out.push({ w: (k / rec.length - 0.5), t: `Over ${line} in ${k} of his last ${rec.length} games` });
  }
  const l3 = e[`${st}_l3`];
  if (l3 != null && l3 > line) out.push({ w: Math.min(0.4, (l3 - line) / Math.max(line, 1)), t: `Averaging ${num1(l3)} over his last 3 games` });
  const med = e[`${st}_med`];
  if (med != null && med > line + 0.5) out.push({ w: Math.min(0.3, (med - line) / Math.max(line, 1)), t: `His typical game is ${num1(med)}` });
  const tt = e.team_implied_total;
  if (tt != null && tt >= 25 && YARDS.has(market)) out.push({ w: (tt - 24) / 40, t: `Team projected for ${num1(tt)} points` });
  const share = e.targets_share ?? e.carries_share;
  if (share != null && share >= 0.25 && ["rec_yards", "receptions", "rush_yards", "carries", "rush_rec_yards"].includes(market)) out.push({ w: 0.1, t: `Gets ${Math.round(share * 100)}% of his team's ${e.targets_share != null ? "targets" : "carries"}` });
  return out.sort((a, b) => b.w - a.w).slice(0, 3).map((x) => x.t);
}
const num1 = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));

/** Under legs across markets: at the book line when books offer one, otherwise at the player's usual line. */
export function underPool(d: AskData, f: Filters = {}, markets?: string[], minChance = 0.55): Pick[] {
  const out: Pick[] = [];
  for (const m of markets ?? Object.keys(d.props)) {
    const label = d.props[m]?.label ?? m;
    for (const r of d.props[m]?.rows ?? []) {
      if (!r.eligible || !r.dist || !propPlays(d, r, m)) continue;
      if (!keep(d, f, { pos: r.position, team: r.team, opp: r.opponent, game_id: r.game_id })) continue;
      const book = feedLine(d.feed, m, r.player_id);
      const line = book ?? usualLine(r, m);
      if (line == null || line <= 0) continue;
      const p = propPick(d, m, r, line, "under");
      if (p.p < minChance) continue;
      out.push({ ...p, lineSource: book != null ? "book" : "usual", reasons: underReasons(r, m, label, line) });
    }
  }
  return out.sort((a, b) => b.p - a.p);
}

export function answerUnders(d: AskData, n: number, f: Filters, markets?: string[]): Answer {
  const pool = underPool(d, f, markets).filter((p) => p.reasons?.length);
  const seen = new Set<string>();
  const picks = pool.filter((p) => (seen.has(p.player_id) ? false : (seen.add(p.player_id), true))).slice(0, n);
  const what = markets?.length === 1 ? (d.props[markets[0]] ? lc(d.props[markets[0]].label) : "") + " " : "";
  if (!picks.length) return none(d, `No strong ${what}unders${describe(f) ? ` for ${describe(f)}` : ""}`, f);
  const usual = picks.some((p) => p.lineSource === "usual");
  const u = d.conf?.props?.by_side?.under;
  return {
    title: `Where players should fall short: ${what}unders${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: "Most likely unders, with the matchup and form behind each one: the opponent's defense against that position, recent games, role and team scoring outlook.",
    picks, notes: [
      ...(usual ? ["Where no book line is loaded yet, the line shown is the player's usual line (his recent median, rounded to a half point), the same line the track record grades."] : []),
      ...(u ? [`Track record for unders: ${u.map((t) => `${t.tier} ${t.rate != null ? pct(t.rate) : "–"} of ${t.n.toLocaleString()}`).join(", ")}.`] : []),
      ...priceNote(d)],
    followups: ["Receiving yards unders", "Passing yards unders", "Best value bets"],
  };
}

export function answerSleepers(d: AskData, n: number, f: Filters): Answer {
  const pool = tdPool(d, f).filter((p) => p.p >= 0.2 && p.p < 0.35);
  const picks = (d.feed.at ? pool.filter((p) => p.edge != null).sort((a, b) => (b.edge as number) - (a.edge as number)) : pool).slice(0, n);
  if (!picks.length) return none(d, "No longer-shot TD picks match that", f);
  return {
    title: `Longer-shot TD picks${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: d.feed.at ? "Players with a 20–35% chance to score, ranked by how far our chance beats the best price." : "Players with a 20–35% chance to score: bigger payouts, lower hit rates.",
    picks, notes: [...noteTier(picks), ...priceNote(d)], followups: ["Top 5 TD scorers", "Best value bets"],
  };
}

export function answerDue(d: AskData, n: number, f: Filters): Answer {
  const picks = tdPool(d, f).filter((p) => p.due).sort((a, b) => (b.due as Due).gap - (a.due as Due).gap).slice(0, n)
    .map((p) => { const x = p.due as Due; return { ...p, reasons: [`${x.actual} TD${x.actual === 1 ? "" : "s"} on ${num1(x.expected)} expected from his carries and targets in ${x.games} games`] }; });
  if (!picks.length) return none(d, "No player is due right now", f);
  const r = d.dueRecord;
  return {
    title: `Due for a touchdown${describe(f) ? ` (${describe(f)})` : ""}`,
    summary: "Players who have scored at least 1.5 fewer TDs this season than their opportunities predicted, biggest gap first. The chance shown already counts that opportunity.",
    picks, notes: [
      r?.hit_rate != null && r.season_td_rate != null && r.avg_chance != null
        ? `In ${r.n.toLocaleString()} past cases, due players scored in ${pct(r.hit_rate)} of games, well above their ${pct(r.season_td_rate)} rate so far and close to the ${pct(r.avg_chance)} the model gave, so the bounce-back is real and already in the chances.`
        : "The chance shown already includes his opportunity, so being due is not added on top.",
      ...priceNote(d)],
    followups: ["Top 5 TD scorers", "Best value bets"],
  };
}

export function answerInjuries(d: AskData, f: Filters): Answer {
  const rows = d.td.filter((r) => status(r) && keep(d, { ...f, safe: false }, { pos: r.position, team: r.team, opp: r.opponent ?? "", game_id: r.game_id ?? "" }))
    .sort((a, b) => (b.p_model ?? 0) - (a.p_model ?? 0)).slice(0, 15);
  if (!rows.length) return { title: "Injury report", summary: "No skill players on this week's injury report match that (or the report is not out yet).", notes: [], followups: ["Top 5 TD scorers"] };
  return {
    title: "Injury report: notable players", summary: "Players listed on the official report, highest TD chance first. Built-in picks leave out anyone Questionable or worse.",
    picks: rows.filter((r) => r.p_model != null).map((r) => tdPick(d, r)), notes: [], followups: ["Top 5 TD scorers"],
  };
}

export function answerRecord(d: AskData): Answer {
  const t = d.conf?.td, p = d.conf?.props;
  const line = (x: { tier: string; rate: number | null; n: number; avg_chance: number | null }) => `${x.tier}: ${x.rate != null ? pct(x.rate) : "–"} hit in ${x.n.toLocaleString()} past picks (average chance ${x.avg_chance != null ? pct(x.avg_chance) : "–"})`;
  return {
    title: "How accurate is the model?",
    summary: t ? `Every chance was tested on games the model had not seen (${t.weeks} weeks since ${t.first_season}). Picks in each tier hit about as often as their chances said.` : "The confidence record is not available.",
    notes: [...(t?.tiers.map((x) => `Anytime TD ${line(x)}`) ?? []), ...(p?.tiers.map((x) => `Props ${line(x)}`) ?? [])],
    followups: ["Top 5 TD scorers", "Best value bets"],
  };
}

function none(d: AskData, title: string, f: Filters): Answer {
  return { title, summary: `Nothing matched${describe(f) ? ` for ${describe(f)}` : ""}. Try widening the filter.`, notes: priceNote(d), followups: EXAMPLES.slice(0, 3) };
}

export function toSim(p: Pick): SimLeg {
  return { id: p.id, market: p.market, player_id: p.player_id, team: p.team, position: p.pos, game_id: p.game_id, p: p.p, side: p.side };
}

/* ------------------------------------------------------------------ question parsing */
export const EXAMPLES = [
  "Give me one TD scorer from each game this week",
  "Who will fall short this week?",
  "Top 5 TD scorers",
  "Safest 3-leg parlay",
  "Best value bets this week",
  "Best WR receiving yards overs",
  "Who scores in the Thursday game?",
  "Longshot TD picks",
  "Who is due for a TD?",
  "Gibbs vs Henry",
  "How accurate is the model?",
];

export type Parsed = { intent: string; n?: number; market?: string; anyMarket?: boolean; noTd?: boolean; side?: "over" | "under"; line?: number; filters: Filters; players: string[]; value: boolean; sameGame: boolean; ambiguous?: string[] };

// Last names that are also everyday words only count when capitalised ("Will Swift score?", not "likely to score").
const COMMON = new Set(["likely", "love", "will", "hill", "white", "young", "brown", "rice", "cook", "best", "king", "price", "golden", "hunt",
  "sweet", "bell", "banks", "mills", "wise", "little", "strong", "hope", "chase", "ward", "still", "power", "swift", "waller", "allen", "james",
  "parsons", "moore", "jones", "smith", "williams", "johnson", "davis", "taylor", "thomas", "jackson", "harris", "scott", "green", "carter",
  "wilson", "lamb", "mann", "field", "fields", "pierce", "worthy", "london", "nation", "god", "goff", "able", "bowers", "warren", "washington",
  "cash", "money", "lock", "locks", "legs", "score", "scorer", "pick", "picks", "game", "week", "over", "under", "value", "parlay"]);

function findPlayers(d: AskData, q: string, raw = q): { ids: string[]; ambiguous: string[] } {
  const caps = new Set(raw.split(/[^A-Za-z'.-]+/).filter((w) => /^[A-Z]/.test(w)).map((w) => norm(w)));
  const names = new Map<string, string>();
  for (const r of d.td) names.set(r.player_id, r.player_name);
  for (const { rows } of Object.values(d.props)) for (const r of rows) if (!names.has(r.player_id)) names.set(r.player_id, r.player_name);
  const words = new Set(q.split(" "));
  const full: string[] = [], byLast = new Map<string, string[]>();
  for (const [id, name] of names) {
    const n = norm(name).replace(/\b(jr|sr|ii|iii|iv)\b/g, "").trim();
    if (n.length > 4 && q.includes(n)) { full.push(id); continue; }
    const parts = n.split(" ");
    const last = parts[parts.length - 1];
    if (last.length >= 4 && words.has(last) && !TEAMS[last] && (!COMMON.has(last) || caps.has(last))) byLast.set(last, [...(byLast.get(last) ?? []), id]);
  }
  if (full.length) return { ids: full, ambiguous: [] };
  const ids: string[] = [], ambiguous: string[] = [];
  for (const [, list] of byLast) {
    if (list.length === 1) ids.push(list[0]);
    else {
      // Several players share the last name: keep the one with the highest TD chance, list the rest.
      const ranked = list.map((id) => ({ id, p: d.td.find((r) => r.player_id === id)?.p_model ?? 0 })).sort((a, b) => b.p - a.p);
      ids.push(ranked[0].id);
      ambiguous.push(...ranked.slice(1, 4).map((x) => names.get(x.id) as string));
    }
  }
  return { ids, ambiguous };
}

export function parse(d: AskData, raw: string): Parsed {
  const q = ` ${norm(raw)} `;
  const filters: Filters = {};
  for (const [re, p] of POS) if (re.test(q)) { filters.position = p; break; }
  const teams = new Set<string>();
  for (const [k, code] of Object.entries(TEAMS)) if (q.includes(` ${k} `)) teams.add(code);
  for (const tok of raw.split(/[^A-Za-z]+/)) if (tok.length >= 2 && tok === tok.toUpperCase() && CODES.has(tok) && !["QB", "RB", "WR", "TE"].includes(tok)) teams.add(tok);
  if (teams.size) filters.teams = [...teams];
  for (const [k, v] of Object.entries(DAYS)) if (q.includes(` ${k} `) || q.includes(` ${k}s `)) { filters.day = v; break; }
  if (/\b(tonight|tonights)\b/.test(q)) filters.day = new Date().getDay();
  if (/\b(include|including|even|any) (questionable|injured)\b/.test(q)) filters.safe = false;

  let market: string | undefined;
  for (const [m, re] of MARKET_WORDS) if (re.test(q)) { market = m; break; }
  const anyMarket = !market && /\b(any|all|every|whatever) (props?|markets?|bets?|types?|stats?|kinds?|categor(y|ies))\b|\bany prop\b|\bacross (all )?(markets|props)\b|\b(doesnt|does not|dont) (have to|need to) be (a )?(td|touchdown)/.test(q);
  const td = /\b(tds?|touchdowns?|score|scores|scorer|scorers|scoring|anytime|find the end ?zone|endzone|end zone)\b/.test(q);
  if (td && market && !["pass_tds"].includes(market) && !/(yards|yds|receptions|catches|carries|completions|attempts)/.test(q)) market = undefined;
  const side = /\b(unders?|less than|fewer|stay under)\b/.test(q) ? "under" : /\b(overs?|more than|at least|go over|exceed)\b/.test(q) ? "over" : undefined;

  // "250 passing yards", "throw for 300", "100+ rushing yards", "6+ catches", "over 59.5": a line, not a count.
  let line: number | undefined;
  const lm = q.match(/\b(?:over|under|at least|more than|fewer than|less than|for|clear|hit|reach|get)\s+(\d+(?:\.\d)?)\b/) ?? q.match(/\b(\d+(?:\.\d)?)\s*(?:\+\s*)?(?:or more\s+)?(?:pass(ing)?|rush(ing)?|rec(eiving)?|receptions?|catches|carries|completions|yards|yds)/);
  if (lm) {
    const v = Number(lm[1]);
    line = Number.isInteger(v) ? v - 0.5 : v;
    if (!market) market = /\b(throw|pass)/.test(q) ? "pass_yards" : /\b(run|rush)/.test(q) ? "rush_yards" : /\b(catch|receiv)/.test(q) && v >= 15 ? "rec_yards" : market;
    if (!market && v >= 15) market = filters.position === "QB" ? "pass_yards" : filters.position === "RB" ? "rush_yards" : filters.position ? "rec_yards" : undefined;
    if (!market) line = undefined;
  }
  let n: number | undefined;
  // "from all 14 games" sizes the slate, not the answer.
  const qn = q.replace(lm?.[0] ?? "@@", " ").replace(/\b(all |the |of |these |this weeks )?(\d{1,2}|[a-z]+teen|ten|eleven|twelve) (games|matchups)\b/g, " ");
  const dm = qn.match(/\b(\d{1,2})\b/);
  if (dm) n = Number(dm[1]);
  else for (const [w, v] of Object.entries(NUM)) if (new RegExp(`\\b${w}\\b(?! (each|every|per)\\b)`).test(qn) && w !== "a") { n = v; break; }
  if (n == null && /\b(the|a|one|single) (single )?(safest|surest|best|most likely|top|strongest|highest rated|top rated|highest) (pick|bet|play|leg|prop|lock)\b(?!s)|\b(safest|surest) (pick|bet|play|leg|prop|lock)\b(?!s)/.test(qn)) n = 1;
  const value = /\b(value|edges?|ev|plus ev|\+ev|beat(ing)? the books?|mispriced|soft lines?|overlay|bang for)\b/.test(q);
  const sameGame = /\b(same ?game|sgp|in this game|in the game)\b/.test(q) || (teams.size > 0 && /\bparlay\b/.test(q));
  const pl = findPlayers(d, q, raw);
  // "prop" without a named stat means any market, and so does a generic "safest/best pick" with no TD wording.
  const anyM = anyMarket || (!td && !market && (/\bprops?\b/.test(q)
    || (/\b(safest|surest|most likely|best|strongest|highest|top rated|highest rated|most confident)\b/.test(q) && /\b(picks?|bets?|plays?|legs?)\b/.test(q))));
  const noTd = /\b(no|not|non|without|excluding|except|besides|other than) (an? )?(anytime )?(tds?|touchdowns?)\b/.test(q);
  const base = { n, market, anyMarket: anyM || noTd, noTd, side: line != null && !side ? "over" as const : side, line, filters, players: pl.ids, value, sameGame, ambiguous: pl.ambiguous } as const;

  if (/\b(what can you|help me|how do i use|what do you know)\b/.test(q)) return { ...base, intent: "help" };
  if (/\b(accura|track record|hit rate|how good is (the|your) model|trust (the|your)|calibrat|how often .* (hit|right))/.test(q)) return { ...base, intent: "record" };
  if (/\b(injur|questionable|doubtful|hurt|out this week|inactive)/.test(q) && !/\b(parlay|best|top)\b/.test(q)) return { ...base, intent: "injuries" };
  if (/\b(avoid|fade|stay away|overpriced|overrated|traps?|worst bets?|bad bets?)\b/.test(q)) return { ...base, intent: "avoid" };
  if (/\b(each|every|per|all) (game|matchup|contest)s?\b|\bfrom every\b|\bgame by game\b|\beach of the games\b/.test(q)) return { ...base, intent: "pergame" };
  if (/\b(parlay|parlays|legs?|slip|accumulator|multi)\b/.test(q)) return { ...base, intent: "parlay" };
  if (/\b(fall short|come up short|struggle|won'?t (hit|reach|get)|held (in check|under)|shut ?down|bust|unders?)\b/.test(q) && !/\b(parlay|each|every)\b/.test(q)) return { ...base, intent: "unders" };
  if ((anyM || noTd) && !/\b(parlay|parlays|value|unders?|fall short)\b/.test(q) && !pl.ids.length) return { ...base, intent: "any" };
  if (/\b(longshots?|long shots?|sleepers?|dark ?horse|big payout|plus money|underdogs? to score|lottery)\b/.test(q)) return { ...base, intent: "sleepers" };
  if (pl.ids.length && !/\b(top|best|safest|most likely|highest)\b/.test(q) && line == null) return { ...base, intent: "player" };
  if (/\b(due|overdue|bounce ?back|unlucky|positive regression|buy ?low)\b/.test(q) && !/\bparlay\b/.test(q)) return { ...base, intent: "due" };
  if (value) return { ...base, intent: "value" };
  if (market) return { ...base, intent: "props" };
  if (teams.size && (teams.size > 1 || /\b(vs|versus|game|matchup|against|at)\b/.test(q) || !(td || /\b(top|best|safest|picks?|bets?|who)\b/.test(q)))) return { ...base, intent: "game" };
  if (teams.size === 1) filters.teamOnly = true;
  if (td || /\b(top|best|safest|most likely|locks?|highest|picks?|bets?|who should i|recommend|surest|confident)\b/.test(q)) return { ...base, intent: "top" };
  if (pl.ids.length) return { ...base, intent: "player" };
  return { ...base, intent: "help" };
}

export function answer(d: AskData, raw: string): Answer {
  const p = parse(d, raw);
  const f = p.filters;
  let a: Answer;
  switch (p.intent) {
    case "record": a = answerRecord(d); break;
    case "injuries": a = answerInjuries(d, f); break;
    case "pergame": a = answerPerGame(d, p.market ?? (p.noTd ? "any-props" : p.anyMarket ? "any" : "td"), f); break;
    case "parlay": a = answerParlay(d, Math.min(Math.max(p.n ?? 3, 2), 8), f, { market: p.market, value: p.value, sameGame: p.sameGame }); break;
    case "sleepers": a = answerSleepers(d, p.n ?? 6, f); break;
    case "due": a = answerDue(d, p.n ?? 8, f); break;
    case "any": a = answerAny(d, Math.min(p.n ?? 5, 25), f, p.noTd); break;
    case "player": a = answerPlayer(d, p.players.slice(0, 3), p.market ?? (/\b(td|touchdown|score)/.test(norm(raw)) ? "td" : undefined)); break;
    case "avoid": a = answerAvoid(d, p.n ?? 8, f); break;
    case "unders": a = p.line != null && p.market ? answerProps(d, p.market, p.n ?? 10, f, "under", p.line) : answerUnders(d, p.n ?? 8, f, p.market ? [p.market] : undefined); break;
    case "value": a = answerValue(d, p.n ?? 8, f, p.market ? [p.market] : /\b(tds?|touchdowns?|scor)/.test(norm(raw)) ? ["td"] : undefined); break;
    case "props": a = answerProps(d, p.market as string, p.n ?? (p.line != null ? 10 : 8), f, p.side, p.line); break;
    case "game": a = answerGame(d, f.teams as string[], f); break;
    case "top": a = answerTop(d, Math.min(p.n ?? 5, 25), f); break;
    default:
      return { title: "I can help with that if you phrase it like one of these", summary: "Ask about touchdown scorers, player props, parlays, value against the books, a team, a game, a player, or the model's record. Filters like position (WR), team (Bears) and day (Thursday) work in any question.", notes: [], followups: EXAMPLES };
  }
  if (p.ambiguous?.length) a.notes = [`Several players match that name; showing the one most likely to matter. Others: ${p.ambiguous.join(", ")}.`, ...a.notes];
  return a;
}

/** Compact, number-only view of the week for the AI mode's tools. */
export const pickJson = (p: Pick) => ({ player: p.name, team: p.team, opponent: p.opp, position: p.pos, game: gameLabel(p.game_id), bet: p.label,
  our_chance: Number(p.p.toFixed(3)), best_price: p.price != null ? fmtPrice(p.price) : null, book: p.book ?? null,
  price_implied_chance: p.price != null ? Number((1 / dec(p.price)).toFixed(3)) : null, edge: p.edge != null ? Number(p.edge.toFixed(3)) : null,
  tier: p.tier ?? null, tier_past_hit_rate: p.tierRate != null ? Number(p.tierRate.toFixed(3)) : null, note: p.note ?? null,
  projection: p.median != null ? { median: p.median, range_10_90: p.range } : null, reasons: p.reasons ?? null,
  due: p.due ? { tds: p.due.actual, expected_tds: Number(p.due.expected.toFixed(2)), games: p.due.games } : null,
  line_source: p.lineSource === "usual" ? "player's usual line (no book line loaded)" : p.line != null ? "book line" : null });

export const answerJson = (a: Answer) => ({ title: a.title, summary: a.summary, picks: a.picks?.map(pickJson),
  groups: a.groups?.map((g) => ({ title: g.title, picks: g.picks.map(pickJson) })), parlay: a.parlay ?? null,
  projections: a.projections ?? null, notes: a.notes });
