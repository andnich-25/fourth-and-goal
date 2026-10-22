/* Optional AI mode for the Ask page. The visitor's own Anthropic API key stays in this browser (localStorage) and is
   sent only to api.anthropic.com. Claude answers only through tools that run the site's own answer functions, so
   every number it quotes comes from the published data. */
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema.mjs";
import {
  answerDue, answerGame, answerInjuries, answerJson, answerParlay, answerPerGame, answerPlayer, answerProps, answerRecord, answerSleepers, answerTop,
  answerUnders, answerValue, gameLabel, parse, type AskData, type Filters,
} from "@/lib/ask";
import { MODEL } from "@/lib/aiKey";


const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const POSITION = { type: "string", enum: ["QB", "RB", "WR", "TE"], description: "Only this position" } as const;
const TEAMS = { type: "array", items: { type: "string" }, description: "Team codes such as CHI, NE, DET, LA (Rams), LAC, LV, JAX, WAS" } as const;
const DAY = { type: "string", enum: DAYS, description: "Only games on this weekday" } as const;
const SIDE = { type: "string", enum: ["over", "under"] } as const;

function filters(i: { position?: string; teams?: string[]; day?: string; include_questionable?: boolean }): Filters {
  return { position: i.position, teams: i.teams?.map((t) => t.toUpperCase()), day: i.day ? DAYS.indexOf(i.day) : undefined, safe: i.include_questionable ? false : undefined };
}
const out = (x: unknown) => JSON.stringify(x);

function tools(d: AskData) {
  const markets = Object.keys(d.props);
  const MARKET = { type: "string", enum: markets, description: "Prop market" } as const;
  return [
    betaTool({
      name: "list_games", description: "This week's games with kickoff day and time.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as const,
      run: async () => {
        const m = new Map<string, { game: string; day: string | null; kickoff: string | null }>();
        for (const r of d.td) if (r.game_id && !m.has(r.game_id)) m.set(r.game_id, { game: gameLabel(r.game_id), day: r.gameday ?? null, kickoff: r.gametime ?? null });
        return out({ season: d.season, week: d.week, games: [...m.values()], prices_loaded: !!d.feed.at, prices_as_of: d.feed.at });
      },
    }),
    betaTool({
      name: "top_td_scorers", description: "Players most likely to score an anytime TD this week, with validated chance, confidence tier and best sportsbook price. Leaves out Questionable/Doubtful players unless include_questionable.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 40 }, position: POSITION, teams: TEAMS, day: DAY, include_questionable: { type: "boolean" } }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerTop(d, i.limit, filters(i)))),
    }),
    betaTool({
      name: "best_per_game", description: "The single most likely leg in each game (anytime TD by default, or a prop market), plus how likely several of them hit together.",
      inputSchema: { type: "object", properties: { market: { type: "string", enum: ["td", ...markets] }, position: POSITION, day: DAY }, additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerPerGame(d, i.market ?? "td", filters(i)))),
    }),
    betaTool({
      name: "prop_picks", description: "Most likely over/under sides for a prop market at the line most books offer. If no lines are loaded, returns projections (median and 80% range) instead.",
      inputSchema: { type: "object", properties: { market: MARKET, side: SIDE, limit: { type: "integer", minimum: 1, maximum: 30 }, position: POSITION, teams: TEAMS, day: DAY }, required: ["market", "limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerProps(d, i.market, i.limit, filters(i), i.side))),
    }),
    betaTool({
      name: "value_bets", description: "Legs where our chance beats the chance implied by the best US sportsbook price by at least 3 points, widest edge first.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 30 }, markets: { type: "array", items: { type: "string", enum: ["td", ...markets] } }, position: POSITION, teams: TEAMS, day: DAY }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerValue(d, i.limit, filters(i), i.markets))),
    }),
    betaTool({
      name: "build_parlay", description: "Builds a parlay with 40,000 correlated simulations: either the most likely combination, or (value=true) only legs that beat the best price, combined for the highest expected return.",
      inputSchema: { type: "object", properties: { legs: { type: "integer", minimum: 2, maximum: 8 }, market: { type: "string", enum: ["td", ...markets] }, value: { type: "boolean" }, same_game: { type: "boolean", description: "Allow several legs from one game" }, position: POSITION, teams: TEAMS, day: DAY }, required: ["legs"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerParlay(d, i.legs, filters(i), { market: i.market, value: i.value, sameGame: i.same_game }))),
    }),
    betaTool({
      name: "player_lookup", description: "Every validated chance for one or more players this week (anytime TD and props).",
      inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 } }, required: ["names"], additionalProperties: false } as const,
      run: async (i) => {
        const ids = parse(d, i.names.join(" and ")).players;
        return ids.length ? out(answerJson(answerPlayer(d, ids))) : out({ error: "No player with that name has chances this week." });
      },
    }),
    betaTool({
      name: "game_breakdown", description: "Most likely TD scorers and strongest prop sides in the game involving the given team(s).",
      inputSchema: { type: "object", properties: { teams: TEAMS }, required: ["teams"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerGame(d, i.teams.map((t) => t.toUpperCase()), {}))),
    }),
    betaTool({
      name: "unders", description: "Players most likely to fall short of a line (unders), with the matchup and form reasons behind each: opponent defense vs the position, recent games, role, team scoring outlook. Uses the book line when loaded, else the player's usual line.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 30 }, markets: { type: "array", items: { type: "string", enum: markets } }, position: POSITION, teams: TEAMS, day: DAY }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerUnders(d, i.limit, filters(i), i.markets))),
    }),
    betaTool({
      name: "longshot_td", description: "TD picks with a 20-35% chance (bigger payouts), ranked by edge over the best price when prices are loaded.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 }, position: POSITION, teams: TEAMS }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerSleepers(d, i.limit, filters(i)))),
    }),
    betaTool({
      name: "due_for_td", description: "Players who have scored at least 1.5 fewer TDs this season than their carries and targets predicted (expected TDs), with how such players have scored in the past. Their chance already includes that opportunity.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 }, position: POSITION, teams: TEAMS, day: DAY }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerDue(d, i.limit, filters(i)))),
    }),
    betaTool({
      name: "injury_report", description: "Skill players on this week's official injury report with their TD chance.",
      inputSchema: { type: "object", properties: { teams: TEAMS }, additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerInjuries(d, filters(i)))),
    }),
    betaTool({
      name: "model_record", description: "How often past picks in each confidence tier actually hit on unseen weeks.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as const,
      run: async () => out(answerJson(answerRecord(d))),
    }),
  ];
}

const SYSTEM = `You are the question box on Fourth & Goal, an NFL touchdown and player-prop analytics site. Answer the visitor's betting question for the current week using only the tools.

Rules:
- Every chance, price, line, edge, projection and hit rate you mention must come from a tool result in this conversation. Never estimate, round up or add numbers of your own. If the tools do not cover something (weather, news, a market the site does not model), say so plainly.
- Chances are validated model probabilities; "tier" and "tier_past_hit_rate" say how often past picks in that range hit. Prefer higher chances and, when prices are loaded, real edges. Mention injury notes.
- Call several tools when the question needs it (for example list_games, then best_per_game). Pass filters (position, teams, day) when the question names them.
- Keep the answer short and scannable: a one-line lead, then a list of picks (player, team, bet, our chance, best price if any), then at most two short caveats. No guarantees; book prices are sharp and no bet is a sure thing.`;

export type AiTurn = { role: "user" | "assistant"; text: string };

export async function askAi(key: string, d: AskData, question: string, history: AiTurn[], onStatus?: (s: string) => void): Promise<string> {
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: `${SYSTEM}\n\nThis is ${d.season} week ${d.week}.`,
    tools: tools(d),
    messages: [...history.map((t) => ({ role: t.role, content: t.text })), { role: "user", content: question }],
    max_iterations: 8,
  });
  for await (const msg of runner) {
    const used = msg.content.filter((b) => b.type === "tool_use").map((b) => (b as { name: string }).name);
    if (used.length) onStatus?.(`Checking ${used.join(", ").replace(/_/g, " ")}…`);
  }
  const final = await runner.done();
  if (final.stop_reason === "refusal") return "The AI declined to answer that one. Try the built-in answer instead.";
  return final.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
}
