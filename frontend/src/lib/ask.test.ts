import { describe, expect, it } from "vitest";
import { answer, anyPool, estimatedLine, parse, type AskData } from "./ask";
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
    ["What props have a 100% hit rate?", "hitrate"],
    ["unders that hit 90% of the time last 5", "hitrate"],
    ["who is on a hot streak", "hitrate"],
    ["worst defenses against running backs", "defense"],
    ["best matchups for WRs this week", "defense"],
    ["highest scoring games this week", "games"],
    ["what does edge mean", "glossary"],
    ["what is a tier", "glossary"],
    ["most projected receiving yards", "leaders"],
    ["What is the safest pick from all 14 games. It can be any prop", "any"],
    ["best bets this week any market", "any"],
    ["give me the highest rated prop from each game", "pergame"],
    ["highest rated props this week", "any"],
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

  it("searches every market for an any-prop question and reads the slate size as context", () => {
    const p = parse(d, "What is the safest pick from all 14 games. It can be any prop");
    expect([p.intent, p.n]).toEqual(["any", 1]);
    const withProps: AskData = { ...d, props: { receptions: { label: "Receptions", rows: [{ player_id: "2", player_name: "Amon-Ra St. Brown", team: "DET", opponent: "TB",
      position: "WR", game_id: "2026_07_TB_DET", eligible: 1, median: 8, q10: 5, q90: 11, evidence: { receptions_med: 8 },
      dist: { type: "quantiles", q: Array.from({ length: 99 }, (_, i) => 3 + i * 0.1), platt: [1, 0] } }] } } };
    const a = answer(withProps, "safest pick, any prop");
    expect(a.picks?.length).toBe(1);
    expect(a.picks?.[0].market).not.toBe(undefined);
    expect(parse(d, "safest pick from each game, any market").intent).toBe("pergame");
    expect(answer(withProps, "safest pick from each game").title).toContain("any market");
    expect(answer(withProps, "give me the highest rated prop from each game").title).toContain("any market");
    expect(answer(withProps, "best prop from each game, no TDs").picks?.every((p) => p.market !== "td")).toBe(true);
    expect(answer(d, "one TD scorer from each game").title).toContain("TD scorer");    // The parlay builder's "All markets" list keeps every leg, not just each player's best one.
    const every = anyPool(withProps, {}, undefined, false);
    expect(every.filter((p) => p.player_id === "2").map((p) => p.market).sort()).toEqual(["receptions", "td"]);
    expect(anyPool(withProps).filter((p) => p.player_id === "2")).toHaveLength(1);
    expect(every.map((p) => p.p)).toEqual([...every.map((p) => p.p)].sort((a, b) => b - a));
  });

  it("never shows a line from a different role (a backup's 4.5 pass attempts once he starts)", () => {
    expect(estimatedLine({ median: 23.9, evidence: { attempts_med: 4 } }, "pass_attempts")).toEqual({ line: 23.5, kind: "projected" });
    expect(estimatedLine({ median: 37.2, evidence: { attempts_med: 38.5 } }, "pass_attempts")).toEqual({ line: 38.5, kind: "usual" });
  });

  it("leaves out backup quarterbacks and players without a real role", () => {
    const q = (id: string, name: string, att: number, snap: number) => ({ player_id: id, player_name: name, team: "ATL", opponent: "SF", position: "QB",
      game_id: "2026_07_SF_ATL", eligible: 1, median: 0, q10: 0, q90: 2, evidence: { interceptions_med: 0, attempts_pg: att, snap_pct: snap },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => i / 60), platt: [1, 0] as [number, number] } });
    const wr = { ...q("w", "Deep Reserve", 0, 0.1), position: "WR" };
    const dd: AskData = { ...d, props: { interceptions: { label: "Interceptions thrown", rows: [q("s", "Starter Qb", 30, 0.98), q("b", "Backup Qb", 15, 0.4), wr] } } };
    const names = answer(dd, "safest pick any prop, no TDs").picks?.map((p) => p.name) ?? [];
    expect(names).toContain("Starter Qb");
    expect(names).not.toContain("Backup Qb");
    expect(names).not.toContain("Deep Reserve");
  });

  it("explains why a pick leans the way it does", () => {
    const henry = { player_id: "h", player_name: "Hunter Henry", team: "NE", opponent: "CHI", position: "TE", game_id: "2026_07_NE_CHI", eligible: 1,
      median: 3.6, q10: 1, q90: 6, recent: [2, 3, 5, 2, 3, 4, 1, 6].map((v, i) => ({ season: 2026, week: 6 - i, opponent: "BUF", value: v })),
      evidence: { receptions_med: 4, receptions_l3: 3.3, receptions_cur: 3.5, opp_receptions_mult: 0.85, targets_pg: 5.1, snap_pct: 0.8, team_implied_total: 19.5 },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => 0.5 + i * 0.065), platt: [1, 0] as [number, number] } };
    const dd: AskData = { ...d, props: { receptions: { label: "Receptions", rows: [henry] } } };
    const p = parse(dd, "Why is it suggesting Hunter Henry's under?");
    expect(p.intent).toBe("why");
    const a = answer(dd, "Why is it suggesting Hunter Henry's under?");
    expect(a.picks?.[0].side).toBe("under");
    expect(a.picks?.[0].reasons?.some((r) => r.includes("CHI allows 15% fewer"))).toBe(true);
    expect(a.notes.some((n) => n.startsWith("Projection 3.6"))).toBe(true);
    expect(a.notes.some((n) => n.includes("Last 8 games"))).toBe(true);
  });

  it("builds parlays from every market unless TDs are asked for", () => {
    expect(answer(d, "Give me the best 3 leg parlay for tonights game").title).toContain("any market");
    expect(answer(d, "3 leg TD parlay").title).toContain("TD parlay");
  });

  it("finds props at a hit rate and builds a player's ladder", () => {
    const rec = [6, 7, 8, 6, 9, 7, 6, 10].map((v, i) => ({ season: 2026, week: 6 - i, opponent: "BUF", value: v }));
    const wr = { player_id: "2", player_name: "Amon-Ra St. Brown", team: "DET", opponent: "TB", position: "WR", game_id: "2026_07_TB_DET", eligible: 1,
      median: 7, q10: 4, q90: 10, recent: rec, evidence: { receptions_med: 7, snap_pct: 0.9 },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => 3 + i * 0.08), platt: [1, 0] as [number, number] } };
    // Hit rates list only lines a book posts. Here a main line of 5.5 and an alternate 6.5.
    const feedOf = (rows: { market: string; player_id: string; line: number; alt?: boolean }[]) => {
      const all = rows.flatMap((r) => (["over", "under"] as const).map((side) => ({ ...r, side, book: "DraftKings", price: -110 })));
      return { at: "2026-10-22T01:00:00Z", get: (m: string, p: string, s: string) => all.filter((r) => r.market === m && r.player_id === p && r.side === s) };
    };
    const noBook: AskData = { ...d, props: { receptions: { label: "Receptions", rows: [wr] } } };
    expect(answer(noBook, "What props have a 100% hit rate?").title).toContain("need the books");
    const dd: AskData = { ...noBook, feed: feedOf([{ market: "receptions", player_id: "2", line: 5.5 }, { market: "receptions", player_id: "2", line: 6.5, alt: true }]) };
    const a = answer(dd, "What props have a 100% hit rate?");
    expect(a.picks?.[0].label).toBe("Over 5.5 receptions");
    expect(a.picks?.[0].reasons?.[0]).toContain("8 of 8");
    const b = answer(dd, "what props hit 60% of the time");
    expect(b.picks?.[0].label).toBe("Over 6.5 receptions");
    const l = answer(dd, "St. Brown alt lines receptions");
    expect(l.table?.rows.some((r) => String(r[0]).startsWith("5.5") && String(r[3]).startsWith("8 of 8"))).toBe(true);    // Only lines a book would offer: a QB with one 54-yard game has no 100% passing-yards line, never "over 50.5".
    const qrec = [281, 329, 291, 287, 361, 266, 54, 191].map((v, i) => ({ season: 2026, week: 6 - i, opponent: "TB", value: v }));
    const qb = { player_id: "9", player_name: "Bryce Young", team: "CAR", opponent: "TB", position: "QB", game_id: "2026_07_TB_CAR", eligible: 1,
      median: 241, q10: 147, q90: 327, recent: qrec, evidence: { pass_yards_med: 284, attempts_pg: 33, snap_pct: 1 },
      dist: { type: "quantiles" as const, q: Array.from({ length: 99 }, (_, i) => 120 + i * 2.4), platt: [1, 0] as [number, number] } };
    const qd: AskData = { ...d, props: { pass_yards: { label: "Passing yards", rows: [qb] } }, feed: feedOf([{ market: "pass_yards", player_id: "9", line: 230.5 }]) };
    expect(answer(qd, "What props have a 100% hit rate?").picks ?? []).toHaveLength(0);
    expect(answer(qd, "what props have a 70% hit rate").picks?.[0].line).toBe(230.5);
    // A player the books don't post is never listed, however often he cleared some line.
    expect(answer({ ...qd, feed: feedOf([]) }, "what props have a 70% hit rate").picks ?? []).toHaveLength(0);
    const lad = answer(qd, "Bryce Young passing yards alt lines");
    expect(lad.table?.rows.every((r) => parseFloat(String(r[0])) >= 168)).toBe(true);
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
