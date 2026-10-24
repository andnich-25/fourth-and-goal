/* The Lab's picks: the strongest plays on the board across NFL, NBA and college football, ranked 1 to 10, each with
   its full write-up. Every pick comes from a sport's own proven pool (the same picks its home page and Ask show) and
   every number is one that sport published; this file only chooses, ranks, freezes and grades.
   The board is built by scripts/lab-picks.ts on each site refresh: a pick on the board when its game starts is
   frozen as shown and graded after the final, so the record is never written with hindsight. */
import { anyPool, gameLabel, isProven, answerWhy, type AskData, type Pick } from "./ask";
import { easternToUtc } from "./static";
import { bestOffer, leanOf, marketLabel, MIN_LINE, nbaTier, type NbaRow, type Slate } from "./nba";
import type { AskContext as NbaCtx } from "./nbaAsk";
import { explainRow } from "./nbaAsk";
import { bookName as cfbBook, fmtPrice, pickText, tierOf, type Backtest, type CfbPick, type PropRow as CfbPropRow, type Team, type Week } from "./cfb";
import { isPick as cfbIsPick } from "./cfbAsk";
import { explainGame } from "./cfbExplain";
import { pct0, tidy, type Section } from "./writeup";

export type Sport = "nfl" | "nba" | "cfb";
export const SPORT_LABEL: Record<Sport, string> = { nfl: "NFL", nba: "NBA", cfb: "CFB" };
export type LabResult = "won" | "lost" | "push" | "void";

export type LabPick = {
  id: string; sport: Sport; game_id: string; kickoff: string; matchup: string;
  /** "Jalen Brunson over 24.5 points", "Under 51.5", "Texas ML +135". */
  bet: string; who: string; player_id?: string; market: string; market_label: string;
  /** over / under / yes (anytime TD) / home / away (college sides). team_side: the team a college team total is on. */
  side: string; team_side?: "home" | "away"; line: number | null; line_source: "book" | "usual";
  price: number | null; book: string | null;
  /** The sport's own rating out of 10, as its pages show it. */
  score: number; chance: number;
  tier: string | null; tier_rate: number | null; tier_n: number | null;
  headline: string; sections: Section[]; link: string;
  rank?: number; frozen_at?: string; result?: LabResult; actual?: string;
};

/** Props and touchdowns need 6.0+ (a 60% chance); college picks need 7+, the band that beat the books in testing. */
export const MIN_SCORE = 6;
export const BOARD_SIZE = 10;
const RISKY = new Set(["Questionable", "Doubtful", "Out"]);
const r1 = (v: number) => Math.round(v * 10) / 10;
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/* ------------------------------------------------------------------ NFL */

/** The NFL's proven picks (Strongest picks on the home page): one per player, tier proven on unseen weeks, 6.0+. */
export function nflCandidates(d: AskData): LabPick[] {
  const kick = new Map<string, string>();
  const status = new Map<string, string>();
  for (const r of d.td) {
    if (r.game_id && !kick.has(r.game_id)) { const k = easternToUtc(r.gameday, r.gametime); if (k) kick.set(r.game_id, k); }
    if (r.features?.report_status) status.set(r.player_id, String(r.features.report_status));
  }
  return anyPool(d).filter((p) => isProven(d, p) && p.p * 10 >= MIN_SCORE && !RISKY.has(status.get(p.player_id) ?? "") && kick.has(p.game_id))
    .map((p) => nflPick(d, p, kick.get(p.game_id)!));
}

function nflPick(d: AskData, p: Pick, kickoff: string): LabPick {
  const why = answerWhy(d, [p.player_id], p.kind === "td" ? "td" : p.market, p.side === "yes" ? undefined : p.side);
  const x = why.picks?.find((y) => y.market === p.market) ?? p;
  const td = p.kind === "td";
  const bet = td ? `${p.name} to score a touchdown` : `${p.name} ${lc(p.label)}`;
  const usual = p.lineSource === "usual";
  const pick = [
    `${bet} (${p.team} vs ${p.opp}): ${pct0(p.p)} chance, ${r1(p.p * 10).toFixed(1)} out of 10.`,
    p.tierData?.rate != null ? `${p.tier} tier: ${p.tierData.hits.toLocaleString()} of ${p.tierData.n.toLocaleString()} past picks in that range hit (${pct0(p.tierData.rate)}) on weeks the model never saw.` : "",
    p.price != null && p.book ? `Best price ${fmtPrice(p.price)} at ${p.book}.` : usual ? "No book line is loaded yet, so this is his usual line; check your book's line before betting." : "",
  ];
  return {
    id: `nfl:${p.id}`, sport: "nfl", game_id: p.game_id, kickoff, matchup: gameLabel(p.game_id), bet, who: p.name, player_id: p.player_id,
    market: p.market, market_label: td ? "Anytime TD" : d.props[p.market]?.label ?? p.market, side: p.side, line: p.line ?? null,
    line_source: usual ? "usual" : "book", price: p.price ?? null, book: p.book ?? null, score: r1(p.p * 10), chance: p.p,
    tier: p.tier ?? null, tier_rate: p.tierData?.rate ?? null, tier_n: p.tierData?.n ?? null,
    headline: `The model gives ${p.name} a ${pct0(p.p)} chance${p.tierData?.rate != null ? `; ${p.tier} picks have hit ${pct0(p.tierData.rate)} on unseen weeks` : ""}.`,
    sections: tidy([
      { title: "The pick", lines: pick },
      { title: "Why it hits", lines: x.reasons ?? [] },
      ...(why.sections ?? []),
      { title: "Working against it", lines: x.against ?? [] },
    ]),
    link: `/players/${p.player_id}`,
  };
}

/* ------------------------------------------------------------------ NBA */

/** The NBA's strongest leans (the home page list): 20+ minute players not listed Out, proven tier, 6.0+. */
export function nbaCandidates(slate: Slate, ctx: NbaCtx): LabPick[] {
  const games = new Map(slate.games.map((g) => [g.game_id, g]));
  const out: LabPick[] = [];
  for (const r of slate.rows) {
    if (r.out || r.evidence.minutes_long < 20 || r.line < MIN_LINE || !games.has(r.game_id)) continue;
    const lean = leanOf(r);
    if (!lean || lean.p * 10 < MIN_SCORE) continue;
    const t = nbaTier(ctx.conf, lean.p);
    if (!t || t.tier === "Coin flip" || t.rate == null || t.rate < 0.5) continue;
    out.push(nbaPick(r, lean.side, lean.p, t, games.get(r.game_id)!, ctx));
  }
  return out;
}

function nbaPick(r: NbaRow, side: "over" | "under", p: number, t: NonNullable<ReturnType<typeof nbaTier>>, g: Slate["games"][number], ctx: NbaCtx): LabPick {
  const off = bestOffer(r, side);
  const label = marketLabel(r.market);
  return {
    id: `nba:${r.game_id}:${r.player_id}:${r.market}`, sport: "nba", game_id: String(r.game_id), kickoff: g.time, matchup: `${g.away} at ${g.home}`,
    bet: `${r.player_name} ${side} ${r.line} ${label.toLowerCase()}`, who: r.player_name, player_id: r.player_id, market: r.market, market_label: label,
    side, line: r.line, line_source: r.line_source, price: off?.price ?? null, book: off ? cfbBook(off.book) : null,
    score: r1(p * 10), chance: p, tier: t.tier, tier_rate: t.rate, tier_n: t.n,
    headline: `Projects ${r.mean.toFixed(1)} against a line of ${r.line}; ${t.tier} leans have hit ${pct0(t.rate)} of ${t.n.toLocaleString()} unseen games.`,
    sections: explainRow(r, side, ctx), link: `/nba/players/${r.player_id}`,
  };
}

/* ------------------------------------------------------------------ college football */

export type CfbCtx = { teams?: Team[]; bt?: Backtest; props?: CfbPropRow[] };

/** College football's top picks (the home page list): each game's single best bet, rated 7+ in a proven market. */
export function cfbCandidates(week: Week, ctx: CfbCtx): LabPick[] {
  const seen = new Set<number>();
  const out: LabPick[] = [];
  for (const p of [...week.picks].sort((a, b) => b.score - a.score)) {
    if (!cfbIsPick(p) || seen.has(p.game_id)) continue;
    const g = week.games.find((x) => x.game_id === p.game_id);
    if (!g) continue;
    seen.add(p.game_id);
    out.push(cfbPick(p, g, ctx));
  }
  return out;
}

function cfbPick(p: CfbPick, g: Week["games"][number], ctx: CfbCtx): LabPick {
  const t = tierOf(ctx.bt?.markets[p.market], p.tier);
  // 7, 8 and 9 did not separate in testing, so the headline quotes the whole 7+ band (each band is in the write-up)
  const top = ctx.bt?.rating?.bands.filter((b) => b.lo >= 7 && b.roi != null && b.n) ?? [];
  const n7 = top.reduce((a, b) => a + b.n, 0);
  const roi7 = n7 ? top.reduce((a, b) => a + b.n * (b.roi as number), 0) / n7 : null;
  const chance = p.fair_p ?? p.p;
  const bet = pickText(p);
  return {
    id: `cfb:${p.game_id}:${p.market}:${p.team ?? p.side}`, sport: "cfb", game_id: String(p.game_id), kickoff: p.date, matchup: `${g.away} at ${g.home}`,
    bet, who: p.team ?? bet, market: p.market, market_label: { spread: "Spread", total: "Game total", team_total: "Team total", moneyline: "Moneyline" }[p.market],
    side: p.side, team_side: p.team_side, line: p.line ?? null, line_source: p.market === "team_total" && !p.line_posted ? "usual" : "book",
    price: p.best?.price ?? p.price ?? null, book: p.best?.book ? cfbBook(p.best.book) : null,
    score: r1(p.score), chance, tier: p.tier, tier_rate: t?.rate ?? null, tier_n: t?.n ?? null,
    headline: `${pct0(chance)} chance after calibration, rated ${p.score.toFixed(1)} out of 10${roi7 != null ? `; bets rated 7+ returned ${roi7 >= 0 ? "+" : "−"}${Math.abs(roi7 * 100).toFixed(1)}% per bet over ${n7.toLocaleString()} tested bets` : ""}.`,
    sections: explainGame(g, ctx, { market: p.market, upset: p.market === "moneyline" }), link: `/cfb/game/${p.game_id}`,
  };
}

/* ------------------------------------------------------------------ ranking */

/** Best first: rating, then a real book line over a usual one, then how the pick's tier did in testing, then the chance. */
export function byStrength(a: LabPick, b: LabPick): number {
  return b.score - a.score || Number(a.line_source === "usual") - Number(b.line_source === "usual")
    || (b.tier_rate ?? 0) - (a.tier_rate ?? 0) || b.chance - a.chance;
}

/** The top picks, one per game and one per player, numbered 1 (strongest) down. Fewer than n when fewer qualify. */
export function rankBoard(cands: LabPick[], n = BOARD_SIZE): LabPick[] {
  const games = new Set<string>(), players = new Set<string>();
  const out: LabPick[] = [];
  for (const c of [...cands].sort(byStrength)) {
    const g = `${c.sport}:${c.game_id}`, pl = c.player_id ? `${c.sport}:${c.player_id}` : "";
    if (games.has(g) || (pl && players.has(pl))) continue;
    games.add(g);
    if (pl) players.add(pl);
    out.push({ ...c, rank: out.length + 1 });
    if (out.length === n) break;
  }
  return out;
}

/* ------------------------------------------------------------------ grading */

export type NflSettled = { game_id: string; player_id: string; market: string; status: "graded" | "void"; actual: number | null };
export type NbaGraded = { date: string; game_id: number; player_id: string; market: string; actual: number };
export type Results = { nfl?: NflSettled[]; nba?: { rows: NbaGraded[]; through: string | null }; cfb?: Record<string, [number, number]> };

const vsLine = (v: number, line: number, side: string): LabResult => (v === line ? "push" : (v > line) === (side === "over") ? "won" : "lost");
const n1 = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Grade one frozen pick at the line it was frozen with, from the sport's own graded results. Null while pending. */
export function grade(p: LabPick, res: Results): { result: LabResult; actual: string } | null {
  if (p.sport === "nfl") {
    const r = res.nfl?.find((x) => x.game_id === p.game_id && x.player_id === p.player_id && x.market === p.market);
    if (!r) return null;
    if (r.status === "void" || r.actual == null) return { result: "void", actual: "Did not play" };
    if (p.market === "td") return { result: r.actual ? "won" : "lost", actual: r.actual ? "Scored" : "No touchdown" };
    return { result: vsLine(r.actual, p.line!, p.side), actual: `Finished with ${n1(r.actual)}` };
  }
  if (p.sport === "nba") {
    const r = res.nba?.rows.find((x) => String(x.game_id) === p.game_id && x.player_id === p.player_id && x.market === p.market);
    if (r) return { result: vsLine(r.actual, p.line!, p.side), actual: `Finished with ${n1(r.actual)}` };
    // graded days after this game with no box-score row for him: he did not play
    const day = new Date(p.kickoff).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    return res.nba?.through && res.nba.through > day ? { result: "void", actual: "Did not play" } : null;
  }
  const f = res.cfb?.[p.game_id];
  if (!f) return null;
  const [hp, ap] = f;
  const score = `Final ${ap}–${hp}`;
  if (p.market === "total") return { result: vsLine(hp + ap, p.line!, p.side), actual: `${score} (${hp + ap} total)` };
  if (p.market === "team_total") return { result: vsLine(p.team_side === "home" ? hp : ap, p.line!, p.side), actual: score };
  const margin = p.side === "home" ? hp - ap : ap - hp;
  if (p.market === "moneyline") return { result: margin > 0 ? "won" : "lost", actual: score };
  const cover = margin + (p.line ?? 0);
  return { result: cover === 0 ? "push" : cover > 0 ? "won" : "lost", actual: score };
}

/* ------------------------------------------------------------------ the weekly state */

export type LabState = { updated_at: string | null; board: LabPick[]; frozen: LabPick[] };
export type LabRecord = { n: number; won: number; lost: number; push: number; void: number; rate: number | null };
export type LabBoard = {
  generated_at: string; board: LabPick[]; note: string | null;
  sports: Record<Sport, { loaded: boolean; candidates: number }>;
  record: LabRecord & { by_sport: Record<Sport, LabRecord>; since: string | null };
  recent: LabPick[];
};

/** Picks from the last board whose games have started are frozen as they were shown; the rest are rebuilt. */
export function advance(prev: LabState, cands: LabPick[], res: Results, now: Date): LabState {
  const at = prev.updated_at ?? now.toISOString();
  const started = (p: LabPick) => new Date(p.kickoff) <= now;
  const known = new Set(prev.frozen.map((p) => p.id));
  const frozen = [...prev.frozen, ...prev.board.filter((p) => started(p) && !known.has(p.id)).map((p) => ({ ...p, frozen_at: at }))]
    .map((p) => { if (p.result) return p; const g = grade(p, res); return g ? { ...p, ...g } : p; });
  return { updated_at: now.toISOString(), board: rankBoard(cands.filter((c) => !started(c))), frozen };
}

export function tally(ps: LabPick[]): LabRecord {
  const c = (r: LabResult) => ps.filter((p) => p.result === r).length;
  const won = c("won"), lost = c("lost");
  return { n: won + lost, won, lost, push: c("push"), void: c("void"), rate: won + lost ? won / (won + lost) : null };
}

export function publish(s: LabState, sports: LabBoard["sports"], recentN = 30): LabBoard {
  const settled = s.frozen.filter((p) => p.result);
  const by = Object.fromEntries((["nfl", "nba", "cfb"] as Sport[]).map((sp) => [sp, tally(settled.filter((p) => p.sport === sp))])) as Record<Sport, LabRecord>;
  const n = s.board.length;
  return {
    generated_at: s.updated_at ?? new Date().toISOString(), board: s.board, sports,
    note: n < BOARD_SIZE ? `Only ${n} ${n === 1 ? "pick reaches" : "picks reach"} the proven bar right now, so the list stops at ${n} instead of being padded with weaker plays.` : null,
    record: { ...tally(settled), by_sport: by, since: s.frozen.length ? s.frozen.map((p) => p.kickoff).sort()[0] : null },
    recent: [...s.frozen].sort((a, b) => b.kickoff.localeCompare(a.kickoff)).slice(0, recentN),
  };
}
