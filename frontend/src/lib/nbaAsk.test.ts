import { describe, expect, it } from "vitest";
import { answer } from "./nbaAsk";
import type { NbaRow, Slate } from "./nba";

const cdf = (mu: number) => Array.from({ length: 80 }, (_, k) => {
  // Poisson CDF, good enough for routing tests
  let s = 0, t = Math.exp(-mu);
  for (let i = 0; i <= k; i++) { s += t; t *= mu / (i + 1); }
  return Math.min(1, s);
});
const row = (id: string, name: string, team: string, game: number, market: string, mu: number, line: number, extra: Partial<NbaRow> = {}): NbaRow => ({
  player_id: id, player_name: name, team, opp: team === "NY" ? "BOS" : "NY", pos: "G", home: 1, game_id: game, injury: null, injury_note: null,
  out: false, market, mean: mu, q10: mu - 5, q90: mu + 5, line, line_source: "usual", usual_line: line,
  dist: { type: "nbinom", n: 50, p: 0.5, cdf: cdf(mu), platt: [1, 0] }, p_over: null, offers: [], recent: [mu, mu, mu, mu], recent_minutes: [34, 34, 34, 34],
  due: false, evidence: { minutes: 34, minutes_long: 34, per_min: 0.7, opp_mult: 1, pace: 100, opp_pace: 100, rest: 2, start_rate: 1 }, ...extra,
});
const slate: Slate = {
  date: "2026-10-22", generated_at: "", games: [], odds: { fetched_at: null, plan: "free", props_priced: false },
  rows: [
    row("1", "Jalen Brunson", "NY", 1, "points", 27, 22.5),
    row("2", "Jayson Tatum", "BOS", 1, "points", 26, 30.5),
    row("3", "Luka Doncic", "LAL", 2, "points", 30, 29.5, { due: true }),
    row("1", "Jalen Brunson", "NY", 1, "assists", 7, 6.5),
    row("4", "Hurt Guy", "NY", 1, "points", 20, 19.5, { out: true }),
  ],
};

describe("nba ask", () => {
  it("answers a player threshold question from the distribution", () => {
    const a = answer("Will Brunson score 25 points?", slate);
    expect(a.items).toHaveLength(1);
    expect(a.items[0].line).toBe(24.5);
    expect(a.items[0].p).toBeGreaterThan(0.5);
  });
  it("builds a parlay with one leg per game and never uses Out players", () => {
    const a = answer("3-leg parlay", slate);
    expect(new Set(a.items.map((x) => x.row.game_id)).size).toBe(a.items.length);
    expect(a.items.some((x) => x.row.out)).toBe(false);
    expect(a.parlay?.joint).toBeGreaterThan(0);
  });
  it("filters unders and due players", () => {
    expect(answer("best unders", slate).items.every((x) => x.side === "under")).toBe(true);
    expect(answer("who is due?", slate).items.map((x) => x.row.player_id)).toEqual(["3"]);
  });
});
