import { describe, expect, it } from "vitest";
import { answer, parse, type AskData } from "./ask";
import type { RankingRow } from "./types";

const row = (id: string, name: string, team: string, opp: string, pos: string, p: number, gid: string, day = "2026-10-25"): RankingRow =>
  ({ rank: 1, player_id: id, player_name: name, team, position: pos, opponent: opp, game_id: gid, gameday: day, eligible: true, exclusion: null,
    score: 50, p_model: p, confidence: null, flags: [], reasons: [], features: {}, outcome: null, participated: null }) as RankingRow;
const d: AskData = {
  season: 2026, week: 7, props: {}, conf: undefined, buckets: {}, useCorr: false, feed: { at: null, get: () => [] },
  td: [
    row("1", "Jahmyr Gibbs", "DET", "TB", "RB", 0.63, "2026_07_TB_DET", "2026-10-26"),
    row("2", "Amon-Ra St. Brown", "DET", "TB", "WR", 0.47, "2026_07_TB_DET", "2026-10-26"),
    row("3", "D'Andre Swift", "CHI", "NE", "RB", 0.54, "2026_07_NE_CHI", "2026-10-22"),
    row("4", "Rhamondre Stevenson", "NE", "CHI", "RB", 0.4, "2026_07_NE_CHI", "2026-10-22"),
    row("5", "Isaiah Likely", "NYG", "DAL", "TE", 0.3, "2026_07_DAL_NYG"),
    row("6", "George Pickens", "DAL", "NYG", "WR", 0.47, "2026_07_DAL_NYG"),
  ],
};

describe("ask parser", () => {
  it.each([
    ["Give me one TD scorer from each game this week", "pergame"],
    ["Top 5 TD scorers", "top"],
    ["give me 4 running backs likely to score", "top"],
    ["Safest 3-leg parlay", "parlay"],
    ["Best value bets", "value"],
    ["How accurate is the model?", "record"],
    ["any injuries on the lions", "injuries"],
    ["patriots bears", "game"],
    ["Will Swift score?", "player"],
    ["bets to avoid", "avoid"],
    ["longshot TD picks", "sleepers"],
    ["what can you do", "help"],
    ["Who will fall short this week?", "unders"],
    ["best unders for receivers", "unders"],
    ["who is due for a TD", "due"],
    ["any unlucky receivers due to bounce back", "due"],
  ])("%s -> %s", (q, intent) => expect(parse(d, q).intent).toBe(intent));

  it("reads filters, counts and lines", () => {
    expect(parse(d, "top 10 wide receivers to score").filters.position).toBe("WR");
    expect(parse(d, "top 10 wide receivers to score").n).toBe(10);
    expect(parse(d, "Thursday scorers").filters.day).toBe(4);
    const p = parse(d, "which QBs will throw for 250");
    expect([p.market, p.line, p.side]).toEqual(["pass_yards", 249.5, "over"]);
    expect(parse(d, "likely scorers").players).toEqual([]); // "likely" is a word here, not Isaiah Likely
  });

  it("picks the best scorer from each game", () => {
    const a = answer(d, "one TD scorer from each game");
    expect(a.picks?.map((p) => p.name)).toEqual(["Jahmyr Gibbs", "D'Andre Swift", "George Pickens"]);
  });

  it("limits a one-team question to that team and a matchup to that game", () => {
    expect(answer(d, "who scores for the bears").picks?.map((p) => p.team)).toEqual(["CHI"]);
    expect(answer(d, "patriots bears").groups?.[0].picks.map((p) => p.name)).toEqual(["D'Andre Swift", "Rhamondre Stevenson"]);
  });

  it("flags due players from expected vs actual TDs", () => {
    const due = { ...d, td: d.td.map((r) => (r.player_id === "6" ? { ...r, features: { cur_xtd: 3.4, cur_tds: 1, n_games_cur: 6 } } : r)) };
    const a = answer(due, "who is due for a touchdown");
    expect(a.picks?.map((p) => p.name)).toEqual(["George Pickens"]);
    expect(a.picks?.[0].due?.gap).toBeCloseTo(2.4);
  });

  it("uses same-game legs when only one game matches", () => {
    expect(answer(d, "Thursday 2 leg parlay").picks?.length).toBe(2);
  });
});
