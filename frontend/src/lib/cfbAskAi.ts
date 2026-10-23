/* Optional AI mode for the college football Ask page: Claude reads the question in any wording and answers only
   through tools that run the built-in answer engine (cfbAsk) on the published files. */
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema.mjs";
import { MARKET_LABEL, pickText, type Backtest, type CfbMarket, type PropRow, type Team, type Week } from "@/lib/cfb";
import { answer, type AskAnswer } from "@/lib/cfbAsk";
import { WRITEUP_RULES, runAi, type AiTurn } from "@/lib/aiRunner";

export type CfbAiData = { week: Week; teams: Team[]; props: PropRow[]; bt?: Backtest };
const out = (x: unknown) => JSON.stringify(x);
const MARKETS = ["spread", "total", "team_total", "moneyline"] as const;
const WORD: Record<CfbMarket, string> = { spread: "spread", total: "total", team_total: "team total", moneyline: "moneyline" };

/** Number-only view of a built-in answer. */
export function cfbJson(a: AskAnswer) {
  return {
    title: a.title, summary: a.text ?? null, write_up: a.sections ?? null,
    bets: a.leans.map(({ game, lean: m }) => ({ game: `${game.away} at ${game.home}`, bet: pickText(m), market: MARKET_LABEL[m.market], rating_out_of_10: m.score,
      is_pick: m.proven && m.score >= 7, simulated_chance: m.p, calibrated_chance: m.fair_p ?? null, expected_return_per_dollar: m.ev ?? null,
      best_price: m.best?.price ?? m.price ?? null, book: m.best?.book ?? null, tier: m.tier, proven_in_testing: m.proven, reasons: m.reasons })),
    teams: a.teams.map((t) => ({ team: t.team, record: `${t.w}-${t.l}`, power_rank: t.power_rank, net_rating: t.net, rated_points_for: t.pts_for,
      rated_points_against: t.pts_against, ats: `${t.ats_w}-${t.ats_l}-${t.ats_p}`, over_under: `${t.over}-${t.under}` })),
    props: a.props.map((r) => ({ player: r.player, team: r.team, opponent: r.opp, bet: `${r.side} ${r.line} ${r.label}`, projection: r.mean, rating_out_of_10: r.score,
      chance: r.p, line_source: r.line_source, recent: r.recent, proven_in_testing: r.proven })),
  };
}

function tools(d: CfbAiData) {
  const ask = (q: string) => out(cfbJson(answer(q, d.week, d.teams, d.props, d.bt)));
  const MARKET = { type: "string", enum: MARKETS, description: "Only this market" } as const;
  const TEAM = { type: "string", description: "Team name exactly as list_games or team_rankings spells it, e.g. Ohio State, Miami, Texas A&M" } as const;
  return [
    betaTool({
      name: "list_games", description: "This week's games: teams (exact names), kickoff, line, the model's projected score and win chance, and each game's highest-rated bet.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as const,
      run: async () => out(d.week.games.map((g) => {
        const top = [...g.markets].sort((a, b) => b.score - a.score)[0];
        return { game: `${g.away} at ${g.home}`, away: g.away, home: g.home, date: g.date, neutral: g.neutral, ranks: { away: g.away_rank, home: g.home_rank },
          home_spread: g.line.spread, total: g.line.total, model_score: { away: g.model.away, home: g.model.home }, home_win_chance: g.model.home_win,
          top_bet: top ? { bet: pickText(top), rating: top.score, is_pick: top.proven && top.score >= 7 } : null };
      })),
    }),
    betaTool({
      name: "explain_game", description: "The full write-up for one team's game: who the model favors and by how much, win chance in 5,000 simulations, the line vs the model, every expected team rating side by side (points, EPA/play, success rate, yards per play, explosive rate, turnovers, plays), season records and power ranks, projected score ranges, each bet with its rating, calibrated chance and expected return, the tier and rating-band backtest record, the upset case and what could go wrong. Use for why/favored/who wins/breakdown/preview/rating questions.",
      inputSchema: { type: "object", properties: { team: TEAM, market: MARKET, upset: { type: "boolean", description: "Lead with the underdog's case" } }, required: ["team"], additionalProperties: false } as const,
      run: async (i) => ask(`why is ${i.team} favored ${i.market ? WORD[i.market] : ""} ${i.upset ? "upset" : ""}`),
    }),
    betaTool({
      name: "compare_teams", description: "Two teams side by side. If they play each other this week, the full game write-up; otherwise their season ratings, records and the neutral-field gap.",
      inputSchema: { type: "object", properties: { team_a: TEAM, team_b: TEAM }, required: ["team_a", "team_b"], additionalProperties: false } as const,
      run: async (i) => ask(`${i.team_a} vs ${i.team_b}`),
    }),
    betaTool({
      name: "explain_best_picks", description: "This week's picks (each game's top bet rated 7+), each with the reasons, the matchup edges behind it and its backtest record.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10 }, market: MARKET }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => ask(`why are these the top ${i.limit} picks ${i.market ? WORD[i.market] : ""}`),
    }),
    betaTool({
      name: "upset_watch", description: "Underdogs the simulations give a real chance, model vs market win chance, which are picks, and how underdog value bets did in testing.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 15 } }, additionalProperties: false } as const,
      run: async (i) => ask(`best upset chances top ${i.limit ?? 8}`),
    }),
    betaTool({
      name: "how_it_works", description: "How the ratings and picks are made, and how every market and rating band did in the walk-forward backtest.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as const,
      run: async () => ask("how does the rating work"),
    }),
    betaTool({
      name: "ask_builtin", description: "Any other question in plain English, answered by the site's built-in engine: best picks by market or side, unders/overs, team rankings, against-the-spread and over/under records, player props, featured games.",
      inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false } as const,
      run: async (i) => ask(i.question),
    }),
  ];
}

const SYSTEM = `You are the question box on The Lab's college football page. Answer the visitor's question about this week's games using only the tools.

Rules:
- Every number you mention must come from a tool result in this conversation.
- The model plays every game 5,000 times from opponent-adjusted team ratings. Each bet gets a Lab rating out of 10; only 7+ is a pick, and only markets and tiers that beat the price on unseen seasons can reach 7.
- Use exact team names from list_games when calling other tools. If a team is not found, call list_games and say so.
- For list questions (best picks, unders, rankings), keep it short: a one-line lead and a list of bets with ratings.

${WRITEUP_RULES}`;

export function askCfbAi(key: string, d: CfbAiData, question: string, history: AiTurn[], onStatus?: (s: string) => void): Promise<string> {
  return runAi(key, SYSTEM, tools(d), question, history, onStatus);
}
