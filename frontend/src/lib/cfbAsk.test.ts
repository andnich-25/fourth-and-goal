import { describe, expect, it } from "vitest";
import { answer } from "./cfbAsk";
import type { Backtest, CfbGame, Lean, Team, Week } from "./cfb";

const lean = (market: string, score: number, p: number, extra: Partial<Lean> = {}): Lean =>
  ({ market, side: "home", team_side: "home", p, score, proven: score >= 7 || market === "moneyline", tier: null, reasons: [], best: null, ...extra }) as Lean;
const rating = (pts: number, epa: number) => ({ pts_for: pts, ypp: 5 + epa * 5, plays: 70, epa, success: 0.42 + epa / 2, turnovers: 1.4, explosive: 0.11, games: 7 });
const game = (id: number, markets: Lean[], extra: Partial<CfbGame> = {}): CfbGame =>
  ({ game_id: id, home: `Home${id}`, away: `Away${id}`, markets, featured: true, neutral: false, venue: null, home_rank: null, away_rank: null, notes: [],
    line: { has_line: true, spread: -3, total: 50, ml_home: -150, ml_away: 130 },
    model: { home: 27, away: 24, margin: 3, total: 51, margin_q: [-14, 3, 20], total_q: [35, 51, 67], home_win: 0.6, line_based: true },
    ratings: { home: rating(27, 0.1), away: rating(24, 0.05) }, upset: { team: `Away${id}`, side: "away", p: 0.4, market: 0.42, price: 130, pick: false },
    ...extra }) as unknown as CfbGame;

describe("cfb ask", () => {
  const week = { games: [
    game(1, [lean("moneyline", 3.7, 0.59), lean("total", 9.7, 0.55, { side: "under", line: 50, tier: "Strong" }), lean("spread", 7.5, 0.53, { team: "Home1", line: -3, tier: "Lean" })]),
    game(2, [lean("moneyline", 3.7, 0.58), lean("total", 5.4, 0.53, { side: "over" })]),
    game(3, [lean("total", 7.1, 0.53, { side: "over" })]),
  ] } as unknown as Week;
  const teams = [{ team: "Home1", team_id: 1, conference: "SEC", w: 6, l: 1, ats_w: 4, ats_l: 3, ats_p: 0, over: 3, under: 4, net: 20.5, pts_for: 38, pts_against: 17.5, ypp_for: 6.8, ypp_against: 4.9, plays: 70, power_rank: 4 },
    { team: "Away1", team_id: 2, conference: "SEC", w: 5, l: 2, ats_w: 3, ats_l: 4, ats_p: 0, over: 4, under: 3, net: 15, pts_for: 33, pts_against: 18, ypp_for: 6.1, ypp_against: 5.2, plays: 68, power_rank: 11 },
    { team: "Elsewhere", team_id: 3, conference: "Big Ten", w: 7, l: 0, ats_w: 5, ats_l: 2, ats_p: 0, over: 2, under: 5, net: 25, pts_for: 40, pts_against: 15, ypp_for: 7, ypp_against: 4.5, plays: 66, power_rank: 1 }] as Team[];
  const tier = (t: string, rate: number, proven: boolean) => ({ tier: t, lo: 0.5, hi: 1, n: 1200, hits: 650, rate, avg_chance: 0.55, ci: [null, null], recent_n: 300, recent_rate: rate, proven });
  const bt = { break_even: 110 / 210, recent_seasons: [2024, 2025], first_season: 2014, last_season: 2025, model: { sims: 5000 },
    markets: { total: { n: 9000, rate: 0.53, tiers: [tier("Strong", 0.55, true)], proven: true }, spread: { n: 9000, rate: 0.5, tiers: [tier("Lean", 0.51, false)], proven: false },
      moneyline: { n: 4000, tiers: [], proven: true }, team_total: { n: 0, tiers: [], proven: false } },
    rating: { bands: [{ lo: 9, hi: 10, n: 400, win: 0.57, roi: 0.08, recent_n: 100, recent_roi: 0.05 }], by_market: { total: [{ lo: 9, hi: 10, n: 300, win: 0.57, roi: 0.09, recent_n: 80, recent_roi: 0.04 }] } },
    upsets: { calibration: [{ lo: 0.4, hi: 0.5, n: 800, model: 0.44, market: 0.42, actual: 0.43 }], dogs: 9000, dog_win_rate: 0.3 } } as unknown as Backtest;

  it.skipIf(!process.env.PEEK)("peek", () => {
    const a = answer(process.env.PEEK as string, week, teams, [], bt);
    console.log([a.title, a.text, ...(a.sections ?? []).map((s) => `## ${s.title}\n${s.lines.map((l) => `- ${l}`).join("\n")}`)].join("\n"));
  });

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

  it.each(["Why is Home1 favored?", "Home1 vs Away1 breakdown", "who wins away1 at home1", "explain the home1 spread pick", "Why is home1 rated so high"])(
    "%s gets the full game write-up", (q) => {
      const a = answer(q, week, teams, [], bt);
      const titles = a.sections!.map((s) => s.title);
      expect(titles).toContain("The short answer");
      expect(titles).toContain("Why Home1 is favored");
      expect(titles).toContain("Track record behind the rating");
      const text = a.sections!.flatMap((s) => s.lines).join("\n");
      expect(text).toMatch(/favors Home1 by 3\.0/);
      expect(text).toMatch(/wins 60% of 5,000 simulated games/);
      expect(text).toMatch(/Expected EPA per play/);
      expect(text).toMatch(/power rank 4/);
    });

  it("the write-up quotes the tier and rating band records", () => {
    const text = answer("why is home1 favored", week, teams, [], bt).sections!.flatMap((s) => s.lines).join("\n");
    expect(text).toMatch(/Game total leans in the Strong tier: 1,200 past games, won 55\.0%/);
    expect(text).toMatch(/rated 9–10: 300 graded, won 57\.0%/);
    expect(text).toMatch(/Away1 still wins 40%/);
  });

  it("upset questions lead with the underdog's case", () => {
    const a = answer("Can Away1 pull the upset?", week, teams, [], bt);
    expect(a.sections![1].title).toBe("The upset case for Away1");
    expect(a.sections![1].lines.join(" ")).toMatch(/those dogs really won 43\.0%/);
  });

  it("explains the best picks one by one", () => {
    const a = answer("Why are these the best picks?", week, teams, [], bt);
    expect(a.sections!.length).toBe(2);
    expect(a.sections![0].title).toMatch(/Under 50/);
  });

  it("compares two teams that do not play each other", () => {
    const a = answer("Home1 vs Elsewhere", week, teams, [], bt);
    expect(a.sections![0].lines.join(" ")).toMatch(/Elsewhere would be favored by about 4\.5/);
  });

  it("answers how the rating works", () => {
    const a = answer("How does the rating work?", week, teams, [], bt);
    expect(a.title).toMatch(/How the college football model works/);
    expect(answer("what is the best pick this week", week).title).not.toMatch(/How the/);
  });

  it.each(["why home1", "home1 or away1", "who should win away1 home1", "is home1 the better team", "away1 upset chances", "how good is home1",
    "what do you think of the home1 total", "why is the home1 under rated 9.7", "explain your best bet", "how confident are you in this week's picks",
    "deep dive on away1", "how accurate is the model", "what does a 7 mean"])("%s gets a write-up", (q) => {
    expect(answer(q, week, teams, [], bt).sections?.length).toBeGreaterThan(0);
  });
});
