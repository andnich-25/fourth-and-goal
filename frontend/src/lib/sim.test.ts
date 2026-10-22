import { describe, expect, it } from "vitest";
import { bestPrice, bucketKeys, normInv, rhoFor, simulate, toAmerican, toDecimal, type SimLeg } from "./sim";

const leg = (o: Partial<SimLeg>): SimLeg => ({ id: "x", market: "td", player_id: "p", team: "KC", position: "WR", game_id: "g1", p: 0.4, side: "yes", ...o });

describe("parlay simulation", () => {
  it("uses the same bucket names as the engine", () => {
    expect(bucketKeys("team", "td", "WR", "pass_tds", "QB")).toEqual(["team|pass_tds.QB|td.WR", "team|pass_tds|td", "team"]);
    expect(bucketKeys("player", "td", "WR", "receptions", "WR")).toEqual(["player|receptions|td", "player|receptions|td", "player"]);
  });
  it("treats different games as independent and flips the sign for an under", () => {
    const b = { "team|pass_tds.QB|td.WR": { rho: 0.4, pairs: 1 } };
    const qb = leg({ id: "a", market: "pass_tds", position: "QB", player_id: "q", side: "over" });
    const wr = leg({ id: "b" });
    expect(rhoFor(qb, wr, b)).toBe(0.4);
    expect(rhoFor({ ...qb, side: "under" }, wr, b)).toBe(-0.4);
    expect(rhoFor(qb, { ...wr, game_id: "g2" }, b)).toBe(0);
  });
  it("matches the product for independent legs and raises it for positively linked legs", () => {
    const legs = [leg({ id: "a", p: 0.5 }), leg({ id: "b", p: 0.4, player_id: "q", game_id: "g2" })];
    const r = simulate(legs, {}, true, 60000);
    expect(Math.abs(r.joint - 0.2)).toBeLessThan(0.01);
    const linked = [leg({ id: "a", p: 0.5, market: "pass_tds", position: "QB", player_id: "q", side: "over" }), leg({ id: "b", p: 0.4 })];
    const r2 = simulate(linked, { "team|pass_tds.QB|td.WR": { rho: 0.5, pairs: 1 } }, true, 60000);
    expect(r2.joint).toBeGreaterThan(0.26);
    expect(r2.hits.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
  it("converts odds and finds the best price", () => {
    expect(normInv(0.975)).toBeCloseTo(1.959964, 4);
    expect(toDecimal("+150")).toBeCloseTo(2.5);
    expect(toDecimal("-200")).toBeCloseTo(1.5);
    expect(toAmerican(2.5)).toBe("+150");
    expect(bestPrice({ DraftKings: "-120", FanDuel: "+105", BetMGM: "" })).toEqual({ book: "FanDuel", decimal: 2.05 });
  });
});
