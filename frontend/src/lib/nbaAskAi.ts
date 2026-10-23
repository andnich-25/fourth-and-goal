/* Optional AI mode for the NBA Ask page: Claude reads the question in any wording and answers only through tools
   that run the built-in answer engine (nbaAsk) on the published slate. */
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema.mjs";
import { marketLabel, type NbaCorrelation, type Slate } from "@/lib/nba";
import { answer, type AskAnswer, type AskContext } from "@/lib/nbaAsk";
import { WRITEUP_RULES, runAi, type AiTurn } from "@/lib/aiRunner";

export type NbaAiData = { slate: Slate; cor?: NbaCorrelation; ctx: AskContext };
const out = (x: unknown) => JSON.stringify(x);
const MARKETS = ["points", "rebounds", "assists", "threes", "pra"] as const;

export function nbaJson(a: AskAnswer) {
  return {
    title: a.title, summary: a.text ?? null, write_up: a.sections ?? null, notes: a.bullets ?? null, parlay: a.parlay ?? null,
    picks: a.items.map((x) => ({ player: x.row.player_name, team: x.row.team, opponent: x.row.opp, bet: `${x.side} ${x.line} ${marketLabel(x.row.market)}`,
      chance: Number(x.p.toFixed(3)), score_out_of_10: Number((x.p * 10).toFixed(1)), projection: x.row.mean, range_10_90: [x.row.q10, x.row.q90],
      line_source: x.row.line_source, injury: x.row.injury, note: x.note ?? null })),
  };
}

function tools(d: NbaAiData) {
  const ask = (q: string) => out(nbaJson(answer(q, d.slate, d.cor?.buckets, !!d.cor?.use_correlation, d.ctx)));
  const MARKET = { type: "string", enum: MARKETS } as const;
  return [
    betaTool({
      name: "list_games", description: "Tonight's games with tip-off, book spread and total.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as const,
      run: async () => out({ date: d.slate.date, games: d.slate.games }),
    }),
    betaTool({
      name: "explain_player", description: "Full write-up for one player's prop lean: score out of 10 and chance, the confidence tier's and market's record in testing, the price and edge, the reasons (projection, recent games vs the line, minutes, per-36 rate, opponent vs his position, pace, rest, injury), what works against it, and the live projection check.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, market: MARKET, side: { type: "string", enum: ["over", "under"] } }, required: ["name"], additionalProperties: false } as const,
      run: async (i) => ask(`why ${i.name} ${i.side ?? ""} ${i.market ? marketLabel(i.market).toLowerCase() : ""}`),
    }),
    betaTool({
      name: "game_breakdown", description: "Why one team is favored in a game: the book line (the site does not bet NBA sides), what our player projections add up to, top projected scorers, who is out or uncertain, pace, back-to-backs, home court, the best props in the game and the strongest same-game parlay.",
      inputSchema: { type: "object", properties: { teams: { type: "array", items: { type: "string" }, description: "Team codes or names, e.g. BOS, NY, Lakers" } }, required: ["teams"], additionalProperties: false } as const,
      run: async (i) => ask(`${i.teams.join(" vs ")} preview`),
    }),
    betaTool({
      name: "explain_top_leans", description: "Tonight's strongest leans, each with its reasons and its tier's record in testing.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 5 } }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => ask(`why are these your top ${i.limit} picks`),
    }),
    betaTool({
      name: "ask_builtin", description: "Any other question in plain English, answered by the site's built-in engine: safest picks, unders/overs by stat, a player's line or threshold ('Will Jokic get 12 rebounds?'), recent games, parlays and same-game parlays (simulated), double-doubles, injuries, minutes, due and hot players, edges vs book prices, accuracy and how the scores work.",
      inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false } as const,
      run: async (i) => ask(i.question),
    }),
  ];
}

const SYSTEM = `You are the question box on The Lab's NBA page. Answer the visitor's question about tonight's player props using only the tools.

Rules:
- Every number you mention must come from a tool result in this conversation.
- Scores out of 10 are the model's chance of that side times 10. Picks and parlays use only validated leans; players listed Out are never picked.
- The site does not bet NBA sides or totals. For "why is X favored", explain the book's line with game_breakdown's numbers and say plainly that the favorite is the market's call.
- For list questions, keep it short: a one-line lead and a list of picks with scores.

${WRITEUP_RULES}`;

export function askNbaAi(key: string, d: NbaAiData, question: string, history: AiTurn[], onStatus?: (s: string) => void): Promise<string> {
  return runAi(key, SYSTEM, tools(d), question, history, onStatus);
}
