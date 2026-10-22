/* NBA Ask: plain-English questions answered only from the published slate. It never invents a number: every answer
   is a list of rows from slate.json with the model's chance at the line shown (or at the number in the question). */
import { edgeOf, leanOf, marketLabel, overAt, type NbaRow, type Slate } from "./nba";
import type { Buckets } from "./sim";
import { simulate } from "./sim";

export type AskItem = { row: NbaRow; side: "over" | "under"; line: number; p: number; note?: string };
export type AskAnswer = { title: string; text?: string; items: AskItem[]; parlay?: { joint: number; independent: number; draws: number } };

const MARKET_WORDS: [RegExp, string][] = [
  [/\b(pra|points?\s*\+\s*reb|pts\s*\+\s*reb|p\s*r\s*a|points,? rebounds,? (and )?assists)\b/, "pra"],
  [/\b(threes?|3s|3-pointers?|three-pointers?|3pm|triples?)\b/, "threes"],
  [/\b(rebounds?|boards?|reb)\b/, "rebounds"],
  [/\b(assists?|dimes?|ast)\b/, "assists"],
  [/\b(points?|pts|score|scoring|scorers?)\b/, "points"],
];
const TEAM_WORDS: Record<string, string> = {
  hawks: "ATL", celtics: "BOS", nets: "BKN", hornets: "CHA", bulls: "CHI", cavaliers: "CLE", cavs: "CLE", mavericks: "DAL", mavs: "DAL",
  nuggets: "DEN", pistons: "DET", warriors: "GS", rockets: "HOU", pacers: "IND", clippers: "LAC", lakers: "LAL", grizzlies: "MEM",
  heat: "MIA", bucks: "MIL", timberwolves: "MIN", wolves: "MIN", pelicans: "NO", knicks: "NY", thunder: "OKC", magic: "ORL",
  "76ers": "PHI", sixers: "PHI", suns: "PHX", "trail blazers": "POR", blazers: "POR", kings: "SAC", spurs: "SA", raptors: "TOR",
  jazz: "UTAH", wizards: "WSH",
};

function marketOf(q: string): string | null {
  for (const [re, m] of MARKET_WORDS) if (re.test(q)) return m;
  return null;
}
function teamOf(q: string): string | null {
  for (const [w, t] of Object.entries(TEAM_WORDS)) if (new RegExp(`\\b${w}\\b`).test(q)) return t;
  return null;
}
function countOf(q: string, fallback: number): number {
  const m = q.match(/\b(\d+)[- ]?(leg|legs|picks|players|bets)\b/) || q.match(/\btop (\d+)\b/);
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };
  const w = q.match(/\b(two|three|four|five|six)[- ]?(leg|legs|picks)\b/);
  return Math.min(10, Number(m?.[1]) || (w ? words[w[1]] : 0) || fallback);
}
/** "25 points", "score 30", "over 8.5 rebounds": the number the question asks about. */
function thresholdOf(q: string): number | null {
  const m = q.match(/\b(\d+(?:\.\d+)?)\+?\s*(points?|pts|rebounds?|boards|assists?|threes?|3s|pra)\b/) || q.match(/\b(?:score|over|under|get|hit)\s+(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}
function playersIn(q: string, rows: NbaRow[]): string[] {
  const names = new Map<string, string>();
  for (const r of rows) names.set(r.player_id, r.player_name);
  const hits: string[] = [];
  for (const [id, name] of names) {
    const parts = name.toLowerCase().split(" ");
    const last = parts[parts.length - 1];
    if (q.includes(name.toLowerCase()) || (last.length >= 4 && new RegExp(`\\b${last}\\b`).test(q))) hits.push(id);
  }
  return hits;
}

const usable = (r: NbaRow) => !r.out && r.dist != null;

export function answer(question: string, slate: Slate, buckets: Buckets = {}, useCorrelation = false): AskAnswer {
  const q = question.toLowerCase().trim();
  const rows = slate.rows.filter(usable);
  const market = marketOf(q);
  const team = teamOf(q);
  const wantUnder = /\bunders?\b|\bfewer\b|\bless than\b/.test(q);
  const wantOver = /\bovers?\b|\bmore than\b/.test(q);
  const scoped = rows.filter((r) => (!market || r.market === market) && (!team || r.team === team || r.opp === team));
  const leans = (rs: NbaRow[]) => rs.map((r) => ({ r, l: leanOf(r)! })).filter((x) => x.l && (!wantUnder || x.l.side === "under") && (!wantOver || x.l.side === "over"))
    .sort((a, b) => b.l.p - a.l.p);
  const item = (r: NbaRow, side: "over" | "under", line: number, p: number, note?: string): AskItem => ({ row: r, side, line, p, note });

  if (!slate.rows.length) return { title: "No games on the slate", text: "The next slate is published the morning of game day.", items: [] };

  const who = playersIn(q, slate.rows);
  const threshold = thresholdOf(q);
  if (who.length && !/parlay/.test(q)) {
    const mine = slate.rows.filter((r) => who.includes(r.player_id) && (!market || r.market === market));
    const name = mine[0]?.player_name ?? "That player";
    if (mine.some((r) => r.out)) return { title: `${name} is listed Out`, text: mine[0].injury_note ?? undefined, items: [] };
    if (threshold != null && market) {
      const r = mine.find((x) => x.market === market);
      const line = threshold - 0.5;
      const p = r ? overAt(r, line) : null;
      if (r && p != null) return { title: `${name}: ${threshold}+ ${marketLabel(market).toLowerCase()}`, items: [item(r, "over", line, p, `projects ${r.mean.toFixed(1)}`)],
        text: `About a ${Math.round(p * 100)}% chance of ${threshold} or more.` };
    }
    return { title: name, items: mine.filter((r) => r.dist).map((r) => { const l = leanOf(r)!; return item(r, l.side, r.line, l.p, `projects ${r.mean.toFixed(1)}`); })
      .sort((a, b) => b.p - a.p) };
  }

  if (/parlay|slip|legs?\b/.test(q)) {
    const n = countOf(q, 3);
    const pool = leans(scoped.filter((r) => r.evidence.minutes_long >= 24));
    const used = new Set<number>(); const pick: AskItem[] = [];
    for (const { r, l } of pool) {
      if (used.has(r.game_id)) continue;
      used.add(r.game_id); pick.push(item(r, l.side, r.line, l.p));
      if (pick.length === n) break;
    }
    const sim = simulate(pick.map((x) => ({ id: `${x.row.market}:${x.row.player_id}`, market: x.row.market, player_id: x.row.player_id, team: x.row.team,
      position: x.row.pos, game_id: String(x.row.game_id), p: x.p, side: x.side })), buckets, useCorrelation);
    return { title: `${pick.length}-leg parlay from the strongest leans`, text: "One leg per game, players averaging 24+ minutes.", items: pick,
      parlay: { joint: sim.joint, independent: sim.independent, draws: sim.draws } };
  }

  if (/\bdue\b|bounce back|cold/.test(q)) {
    const due = scoped.filter((r) => r.due).map((r) => { const l = leanOf(r)!; return item(r, l.side, r.line, l.p, `last 4: ${r.recent.slice(0, 4).join(", ")}`); });
    return { title: "Due: under his projection 4 games running", items: due.sort((a, b) => b.row.mean - a.row.mean).slice(0, countOf(q, 15)),
      text: due.length ? "The model's scores already account for the slump." : "Nobody qualifies today." };
  }

  if (/\bedge\b|value|\+ev|beat the book|best price/.test(q)) {
    const e = leans(scoped).map((x) => ({ ...x, e: edgeOf(x.r, x.l) })).filter((x) => x.e);
    if (!slate.odds.props_priced) return { title: "No book prop prices loaded today", text: "Edges need sportsbook prop prices.", items: [] };
    return { title: "Edges against the best price", items: e.slice(0, countOf(q, 10)).map((x) => item(x.r, x.l.side, x.r.line, x.l.p, `+${Math.round(x.e!.edge * 100)} pts vs book`)) };
  }

  if (threshold != null && market) {
    const line = threshold - 0.5;
    const hits = scoped.map((r) => ({ r, p: overAt(r, line) })).filter((x) => x.p != null).sort((a, b) => b.p! - a.p!);
    return { title: `Most likely to get ${threshold}+ ${marketLabel(market).toLowerCase()}`, items: hits.slice(0, countOf(q, 10)).map((x) => item(x.r, "over", line, x.p!, `projects ${x.r.mean.toFixed(1)}`)) };
  }

  const n = countOf(q, 10);
  const what = `${wantUnder ? "unders" : wantOver ? "overs" : "leans"}${market ? ` on ${marketLabel(market).toLowerCase()}` : ""}${team ? ` (${team})` : ""}`;
  return { title: `Strongest ${what} today`, items: leans(scoped.filter((r) => r.evidence.minutes_long >= 20)).slice(0, n).map((x) => item(x.r, x.l.side, x.r.line, x.l.p)) };
}

export const SUGGESTIONS = ["Best unders tonight", "Strongest overs on points", "3-leg parlay", "Who is due?", "Who gets 10+ rebounds?", "Lakers props", "Edges against the books"];
