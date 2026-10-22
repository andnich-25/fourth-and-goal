/* Hit rates at every line: for each player and market, how often he cleared each line in his recent games, next to
   the model's chance for this week. Past hit rates describe what happened; the model's chance is the forecast. */
import { pOver, type PropDist } from "@/lib/props";

export type Recent = { season: number; week: number; opponent: string; value: number };
export type HitRow = { player_id: string; team: string; position: string; opponent: string; median: number; q10: number; q90: number;
  dist: PropDist | null; recent?: Recent[] };
export type Rung = { line: number; over: number | null; hits: number; games: number; hits5: number; games5: number };

export const WINDOWS = [5, 8, 16] as const;

/** Step between ladder lines: half points for small counts, bigger steps for yards. */
export function stepFor(scale: number) {
  return scale <= 30 ? 1 : scale <= 80 ? 5 : 10;
}

/** Lines from below his worst recent game to above his best, each with the model chance and recent hit counts. */
export function ladder(r: HitRow, window = 8): Rung[] {
  const rec = (r.recent ?? []).slice(0, window);
  const vals = [...rec.map((g) => g.value), r.q10, r.q90, r.median];
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const step = stepFor(hi);
  const start = Math.max(0.5, Math.floor(lo / step) * step - (step === 1 ? 0.5 : step / 2) + (step === 1 ? 0 : 0));
  const out: Rung[] = [];
  for (let line = step === 1 ? Math.floor(start) + 0.5 : Math.floor(start / step) * step + 0.5; line <= hi + step && out.length < 30; line += step) {
    if (line < 0.5) continue;
    out.push(rung(r, line, window));
  }
  return out;
}

export function rung(r: HitRow, line: number, window = 8): Rung {
  const rec = (r.recent ?? []).slice(0, window);
  const r5 = rec.slice(0, 5);
  return { line, over: r.dist ? pOver(r.dist, line) : null, hits: rec.filter((g) => g.value > line).length, games: rec.length,
    hits5: r5.filter((g) => g.value > line).length, games5: r5.length };
}

/** The line where his recent hit rate on a side first reaches the threshold: the highest such line for overs, the
 *  lowest for unders. null if he has fewer than minGames recent games or never reaches it inside his range. */
export function lineAtRate(r: HitRow, side: "over" | "under", threshold: number, window = 8, minGames = 5): Rung | null {
  const rec = (r.recent ?? []).slice(0, window);
  if (rec.length < minGames) return null;
  const rungs = ladder(r, window);
  const ok = (x: Rung) => (side === "over" ? x.hits : x.games - x.hits) / x.games >= threshold - 1e-9;
  const cands = rungs.filter(ok);
  if (!cands.length) return null;
  return side === "over" ? cands[cands.length - 1] : cands[0];
}
