/* Player signals shown as symbols: Edge (our chance beats the best sportsbook price) and Due (fewer TDs than his
   opportunities predicted this season). Thresholds match engine/due.py and the value threshold used everywhere else. */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Feed } from "@/lib/feed";

export const DUE_GAP = 1.5;
export const DUE_MIN_GAMES = 3;
export const EDGE_MIN = 0.03;

export type Due = { expected: number; actual: number; games: number; gap: number };
export type Edge = { chance: number; price: number; book: string; implied: number; edge: number; ev100: number };
export type DueBin = { label: string; lo: number; hi: number; n: number; avg_chance: number | null; hit_rate: number | null; season_td_rate: number | null };
export type DueStudy = { available: boolean; due_gap?: number; min_games?: number; bins?: DueBin[]; factored_in?: boolean;
  test?: { weeks: number; gain: number; log_loss_model: number; log_loss_with_gap: number } };

type Features = Record<string, unknown> | undefined | null;
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Season-to-date expected TDs (from where his carries and targets happened) vs TDs scored. */
export function tdLuck(f: Features): Due | null {
  const expected = n(f?.cur_xtd), actual = n(f?.cur_tds), games = n(f?.n_games_cur);
  if (expected == null || actual == null || games == null || games < DUE_MIN_GAMES) return null;
  return { expected, actual, games, gap: expected - actual };
}
export const dueOf = (f: Features): Due | null => { const t = tdLuck(f); return t && t.gap >= DUE_GAP ? t : null; };

const dec = (american: number) => 1 + (american > 0 ? american / 100 : 100 / -american);

/** Anytime-TD edge against the best price at any loaded book; null without prices or below the threshold. */
export function tdEdge(feed: Feed, playerId: string, chance: number | null | undefined, min = EDGE_MIN): Edge | null {
  if (chance == null) return null;
  const best = feed.get("td", playerId, "yes").reduce<{ price: number; book: string } | null>((b, r) => (!b || dec(r.price) > dec(b.price) ? r : b), null);
  if (!best) return null;
  const implied = 1 / dec(best.price);
  const edge = chance - implied;
  return edge >= min ? { chance, price: best.price, book: best.book, implied, edge, ev100: (chance * dec(best.price) - 1) * 100 } : null;
}

export function useDueStudy() {
  return useQuery({ queryKey: ["due-study"], queryFn: () => api.get<DueStudy>("/backtest/due"), staleTime: 5 * 60_000 });
}
export const dueRecord = (s: DueStudy | undefined) => s?.bins?.find((b) => b.lo >= DUE_GAP) ?? null;
