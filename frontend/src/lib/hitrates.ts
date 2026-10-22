/* Hit rates at every line: for each player and market, how often he cleared each line in his recent games, next to
   the model's chance for this week. Past hit rates describe what happened; the model's chance is the forecast. */
import { feedLine, type Feed } from "@/lib/feed";
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

/** The lines a sportsbook would actually let you bet. With alternate lines loaded, exactly the lines the books post.
 *  Otherwise an estimated band around the main book line (or, before lines load, the projection): books stop posting
 *  alternate lines once the price runs past roughly -1000, which lands about 30% either side of the main line
 *  (e.g. 180 passing yards against a 240 main line). Lines like over 50.5 passing yards are never offered. */
export type Playable = { lines: number[] | null; anchor: number; source: "book" | "estimated" };
export function playable(feed: Feed | undefined, market: string, r: HitRow): Playable {
  const main = feed ? feedLine(feed, market, r.player_id) : null;
  if (feed && feed.get(market, r.player_id, "over").some((o) => o.alt)) {
    const lines = new Set<number>();
    for (const side of ["over", "under"]) for (const o of feed.get(market, r.player_id, side)) if (o.line != null) lines.add(o.line);
    return { lines: [...lines].sort((a, b) => a - b), anchor: main ?? Math.floor(r.median) + 0.5, source: "book" };
  }
  return { lines: null, anchor: main ?? Math.floor(r.median) + 0.5, source: "estimated" };
}
/** Every line any loaded book posts for this player and market (main and alternate), lowest first. */
export function bookLines(feed: Feed, market: string, playerId: string, side?: "over" | "under"): number[] {
  const lines = new Set<number>();
  for (const s of side ? [side] : ["over", "under"]) for (const o of feed.get(market, playerId, s)) if (o.line != null) lines.add(o.line);
  return [...lines].sort((a, b) => a - b);
}

export function band(anchor: number): [number, number] {
  const w = Math.max(anchor <= 30 ? 2 : 0, 0.3 * anchor);
  return [Math.max(0.5, anchor - w), anchor + w];
}

/** Every playable line, each with the model chance and recent hit counts. */
export function ladder(r: HitRow, window = 8, pl: Playable = playable(undefined, "", r)): Rung[] {
  if (pl.lines) return pl.lines.map((line) => rung(r, line, window));
  const [lo, hi] = band(pl.anchor);
  const step = stepFor(hi);
  const lines = new Set<number>([pl.anchor]);
  for (let line = Math.ceil((lo - 0.5) / step) * step + 0.5; line <= hi && lines.size < 30; line += step) if (line >= 0.5) lines.add(line);
  return [...lines].sort((a, b) => a - b).map((line) => rung(r, line, window));
}

export function rung(r: HitRow, line: number, window = 8): Rung {
  const rec = (r.recent ?? []).slice(0, window);
  const r5 = rec.slice(0, 5);
  return { line, over: r.dist ? pOver(r.dist, line) : null, hits: rec.filter((g) => g.value > line).length, games: rec.length,
    hits5: r5.filter((g) => g.value > line).length, games5: r5.length };
}

/** The line where his recent hit rate on a side first reaches the threshold: the highest such line for overs, the
 *  lowest for unders, among playable lines only. null if he has fewer than minGames recent games or no playable line reaches it. */
export function lineAtRate(r: HitRow, side: "over" | "under", threshold: number, window = 8, minGames = 5,
  pl: Playable = playable(undefined, "", r)): Rung | null {
  const rec = (r.recent ?? []).slice(0, window);
  if (rec.length < minGames) return null;
  const rungs = ladder(r, window, pl);
  const ok = (x: Rung) => (side === "over" ? x.hits : x.games - x.hits) / x.games >= threshold - 1e-9;
  const cands = rungs.filter(ok);
  if (!cands.length) return null;
  return side === "over" ? cands[cands.length - 1] : cands[0];
}
