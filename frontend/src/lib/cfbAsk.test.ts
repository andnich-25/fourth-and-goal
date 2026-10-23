import { describe, expect, it } from "vitest";
import { answer } from "./cfbAsk";
import type { CfbGame, Lean, Week } from "./cfb";

const lean = (market: string, score: number, p: number, extra: Partial<Lean> = {}): Lean =>
  ({ market, side: "home", team_side: "home", p, score, proven: score >= 7 || market === "moneyline", tier: null, ...extra }) as Lean;
const game = (id: number, markets: Lean[]): CfbGame =>
  ({ game_id: id, home: `Home${id}`, away: `Away${id}`, markets, featured: true, line: { has_line: true, spread: -3, total: 50 }, model: { home: 27, away: 24, home_win: 0.6 } }) as unknown as CfbGame;

describe("cfb ask", () => {
  const week = { games: [
    game(1, [lean("moneyline", 3.7, 0.59), lean("total", 9.7, 0.55, { side: "under" }), lean("spread", 7.5, 0.53)]),
    game(2, [lean("moneyline", 3.7, 0.58), lean("total", 5.4, 0.53, { side: "over" })]),
    game(3, [lean("total", 7.1, 0.53, { side: "over" })]),
  ] } as unknown as Week;

  it("best picks: one per game, only 7+, highest rated first", () => {
    const a = answer("Best picks this week", week);
    expect(a.leans.map((x) => [x.game.game_id, x.lean.score])).toEqual([[1, 9.7], [3, 7.1]]);
  });

  it("says so instead of padding with low ratings", () => {
    const a = answer("best moneylines", week);
    expect(a.leans).toEqual([]);
    expect(a.text).toMatch(/No moneylines rate 7/);
  });

  it("a team's bets are listed by rating", () => {
    expect(answer("Home1", week).leans.map((x) => x.lean.score)).toEqual([9.7, 7.5, 3.7]);
  });
});
