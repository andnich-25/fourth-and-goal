import { describe, expect, it } from "vitest";
import { legResult, priceParlay, sameGame, suggest, type Leg } from "./cfbParlay";
import type { Lean } from "./cfb";

const enc = (v: number[]) => v.map((x) => x.toString(36).padStart(2, "0")).join("");
const lean = (o: Partial<Lean>): Lean => ({ market: "total", side: "over", p: 0.55, score: 7, tier: null, proven: true, best: null, reasons: [], ...o });

describe("cfb parlay", () => {
  it("grades legs on a simulated score", () => {
    expect(legResult(lean({ market: "spread", side: "home", team_side: undefined, line: -7 }), 31, 24)).toBeNull();
    expect(legResult(lean({ market: "spread", side: "away", line: 3.5 }), 24, 21)).toBe(1);
    expect(legResult(lean({ market: "total", side: "under", line: 50.5 }), 28, 24)).toBe(0);
    expect(legResult(lean({ market: "team_total", side: "over", team_side: "away", line: 20.5 }), 10, 21)).toBe(1);
    expect(legResult(lean({ market: "moneyline", side: "home" }), 17, 20)).toBe(0);
  });

  it("prices same-game legs from the simulations", () => {
    // home wins big exactly when the game goes over: the two legs always hit together
    const h = [40, 40, 10, 10], a = [10, 10, 20, 20];
    const sims = enc(h) + enc(a);
    const legs = [lean({ market: "spread", side: "home", line: -10.5 }), lean({ market: "total", side: "over", line: 45.5 })];
    const sg = sameGame(legs, sims);
    expect(sg.joint).toBeCloseTo(0.5);
    expect(sg.independent).toBeCloseTo(0.25);
    const L = (id: string, m: Lean, fair: number): Leg => ({ id, game_id: 1, kind: "line", label: id, sub: "", market: m.market, p: fair, fair, score: 7, ev: null, proven: true, price: -110, lean: m, book: null });
    const pr = priceParlay([L("a", legs[0], 0.5), L("b", legs[1], 0.5)], { generated_at: "", n: 4, games: { "1": sims } });
    expect(pr.chance).toBeCloseTo(0.5);
    expect(pr.groups[0].lift).toBeCloseTo(2);
  });

  it("suggests proven 7+ legs from different games", () => {
    const L = (id: string, game_id: number, score: number, proven = true): Leg => ({ id, game_id, kind: "line", label: id, sub: "", market: "total", p: 0.55, fair: 0.53, score, ev: 0.01, proven, price: -110, book: null });
    expect(suggest([L("a", 1, 9), L("b", 1, 8.5), L("c", 2, 7.5), L("d", 3, 9.5, false), L("e", 4, 6)], 3).map((l) => l.id)).toEqual(["a", "c"]);
  });
});
