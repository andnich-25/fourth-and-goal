/* College football Ask: plain-English questions answered only from the published week, teams and props files.
   It never invents a number: every answer is a list of published leans, teams or props. */
import { MARKET_LABEL, fmtPrice, pickText, type Backtest, type CfbGame, type CfbMarket, type Lean, type PropRow, type Team, type Week } from "./cfb";
import { compareTeams, explainGame, favorites, leanLines, methodLines, ratingEdges, teamLine, trackRecord } from "./cfbExplain";
import { pct0, pct1, tidy, type Section } from "./writeup";

export type AskLean = { game: CfbGame; lean: Lean };

/** Highest rating first; the calibrated chance breaks ties. */
const byRating = (a: AskLean, b: AskLean) => b.lean.score - a.lean.score || (b.lean.fair_p ?? b.lean.p) - (a.lean.fair_p ?? a.lean.p);

/** Each game's single highest-rated lean, best games first. */
export function topPerGame(leans: AskLean[]): AskLean[] {
  const best = new Map<number, AskLean>();
  for (const x of leans) {
    const b = best.get(x.game.game_id);
    if (!b || byRating(x, b) < 0) best.set(x.game.game_id, x);
  }
  return [...best.values()].sort(byRating);
}
/** A pick: rated 7+ (only proven markets and tiers can reach 7). */
export const isPick = (m: Lean) => m.proven && m.score >= 7;
export type AskAnswer = { title: string; text?: string; leans: AskLean[]; teams: Team[]; props: PropRow[]; sections?: Section[]; suggestions?: string[] };

export const SUGGESTIONS = ["Best picks this week", "Why are these the best picks?", "Upset picks", "Best unders",
  "Biggest overs", "Top 10 teams", "How does the rating work?", "Best teams against the spread", "Passing yards props", "Ranked matchups"];

/** The suggestions, with a "why is X favored" for this week's biggest featured game. */
export function suggestionsFor(week: Week | undefined): string[] {
  const g = week?.games.find((x) => x.featured && x.line.has_line) ?? week?.games.find((x) => x.line.has_line);
  if (!g) return SUGGESTIONS;
  const fav = g.model.margin >= 0 ? g.home : g.away;
  return [SUGGESTIONS[0], SUGGESTIONS[1], `Why is ${fav} favored?`, `${g.away} vs ${g.home} breakdown`, ...SUGGESTIONS.slice(2)];
}

/** Questions asking for reasons, a breakdown or a prediction rather than a list. */
const EXPLAIN = /\b(why|explain\w*|reasons?|reasoning|how come|what makes|favou?red|favou?rites?|fav|who (wins|will win|should win|takes it)|winner|predict\w*|preview|break ?down|analy[sz]\w*|matchup|write ?up|deep dive|tell me (about|more)|thoughts|your take|insights?|details?|case for|case against|confident|confidence|trust|rated|rating|score of|edge|vs\.?|versus|against|beat|compare|comparison|better team|who is better|how good)\b/;

const MARKETS: [RegExp, CfbMarket][] = [
  [/\bteam totals?\b/, "team_total"],
  [/\b(totals?|over\/under|o\/u|overs?|unders?|points scored)\b/, "total"],
  [/\b(spreads?|ats|cover|covers|line)\b/, "spread"],
  [/\b(moneylines?|ml|to win|outright|upsets?)\b/, "moneyline"],
];
const PROP_WORDS: [RegExp, string][] = [
  [/\bpass(ing)?\b/, "pass_yds"], [/\brush(ing)?\b/, "rush_yds"], [/\b(receiving|rec)\b/, "rec_yds"], [/\b(receptions|catches)\b/, "receptions"],
];

/** Every team named, in the order written; a name inside a longer one ("Miami" in "Miami (OH)") does not count twice. */
function teamsIn(q: string, names: string[]): string[] {
  const hits: { n: string; at: number; end: number }[] = [];
  for (const n of names) {
    const m = new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`).exec(q);
    if (m) hits.push({ n, at: m.index, end: m.index + n.length });
  }
  const keep = hits.filter((h) => !hits.some((o) => o !== h && o.n.length > h.n.length && o.at <= h.at && o.end >= h.end));
  return keep.sort((a, b) => a.at - b.at).map((h) => h.n);
}
const countOf = (q: string, d: number) => Math.min(25, Number(q.match(/\btop (\d+)\b/)?.[1] || q.match(/\b(\d+) (picks|games|teams|bets)\b/)?.[1]) || d);

export function answer(question: string, week: Week, teams: Team[] = [], props: PropRow[] = [], bt?: Backtest): AskAnswer {
  const q = question.toLowerCase().replace(/[?!]/g, " ").replace(/\s+/g, " ").trim();
  const all: AskLean[] = week.games.flatMap((game) => game.markets.map((lean) => ({ game, lean })));
  const market = MARKETS.find(([re]) => re.test(q))?.[1] ?? null;
  const names = [...new Set([...week.games.flatMap((g) => [g.home, g.away]), ...teams.map((t) => t.team)])];
  const named = teamsIn(q, names);
  const team = named[0] ?? null;
  const empty = { leans: [], teams: [], props: [] };
  const ctx = { teams, bt, props };
  const explain = EXPLAIN.test(q);
  const upsetQ = /\b(upsets?|underdogs?|dogs?|outright|sleepers?)\b/.test(q);

  // how the site works and how accurate it is
  if (!team && /\b(how (does|do|is|are) (the |your |this |a )?(ratings?|model|scores?|sim\w*|picks? (get )?made|it work|you (pick|rate))|what (does|do) (a |the )?(ratings?|scores?|\d+(\.\d)?( out of 10)?|7\+?) mean|how accurate|accuracy|track record|backtest\w*|how (good|reliable) is|can i trust|methodology|how do you (pick|make|rate|decide|choose)|how are (the )?(picks|ratings) made)\b/.test(q)) {
    return { ...empty, title: "How the college football model works", sections: methodLines(bt),
      text: "The rating, how it is built and how each market and rating band did on seasons the model never saw." };
  }

  // two teams: their game, or a side-by-side when they do not play each other
  if (named.length >= 2) {
    const [a, b] = named;
    const g = week.games.find((x) => [x.home, x.away].includes(a) && [x.home, x.away].includes(b));
    if (g) return gameAnswer(g, ctx, market, upsetQ);
    const ta = teams.find((t) => t.team === a), tb = teams.find((t) => t.team === b);
    if (ta && tb) return { ...empty, title: `${a} vs ${b}`, teams: [ta, tb], sections: compareTeams(ta, tb), text: "They do not play each other this week." };
  }
  // props
  const pm = PROP_WORDS.find(([re]) => re.test(q))?.[1];
  if (/\bprops?\b/.test(q) || (pm && /\byards|yds|props?|receptions|catches\b/.test(q))) {
    const rows = props.filter((r) => (!pm || r.market === pm) && (!team || r.team === team || r.opp === team)).sort((a, b) => b.score - a.score || b.p - a.p);
    return { ...empty, title: `${pm ? rows[0]?.label ?? "Player" : "Player"} props${team ? `: ${team}` : ""}`, props: rows.slice(0, countOf(q, 12)),
      text: rows.length ? "Featured games only (books post college props for the big games). A prop is a pick only at a posted line in a proven tier." : "No props for that this week: books post them for the featured games only." };
  }
  // teams: rankings, ATS, over/under records
  if (/\b(rank|ranking|rankings|power|best teams|top \d+ teams|top teams|ratings?)\b/.test(q) && !team) {
    return { ...empty, title: `Top ${countOf(q, 10)} teams by power rating`, teams: teams.slice(0, countOf(q, 10)),
      text: "Net = expected margin against an average FBS team on a neutral field." };
  }
  if (/\b(against the spread|ats record|cover the most|covering)\b/.test(q) && !team) {
    const rows = [...teams].sort((a, b) => (b.ats_w - b.ats_l) - (a.ats_w - a.ats_l)).slice(0, countOf(q, 10));
    return { ...empty, title: "Best records against the spread this season", teams: rows, text: "Past covers do not predict future covers on their own; the model's spread leans did not beat closing lines in testing." };
  }
  if (/\b(over record|overs record|go over|hit the over)\b/.test(q) && !team) {
    const rows = [...teams].sort((a, b) => (b.over - b.under) - (a.over - a.under)).slice(0, countOf(q, 10));
    return { ...empty, title: "Teams whose games go over most this season", teams: rows };
  }
  // one team: the full write-up for its game
  if (team) {
    const g = week.games.find((x) => x.home === team || x.away === team);
    const t = teams.find((x) => x.team === team);
    if (!g) return { ...empty, title: team, teams: t ? [t] : [], text: "No game this week.", sections: t ? [{ title: `${team} this season`, lines: [teamLine(t)] }] : undefined };
    return gameAnswer(g, ctx, market, upsetQ);
  }
  // "why are these the picks", "explain your best bet"
  if (explain && /\b(picks?|bets?|plays?|locks?|best|top|these|them|this week|your)\b/.test(q) && !upsetQ) {
    const pool = all.filter((x) => !market || x.lean.market === market);
    const picks = topPerGame(pool.filter((x) => isPick(x.lean))).slice(0, countOf(q, /\b(pick|bet|play|lock)\b(?!s)/.test(q) ? 1 : 5));
    if (!picks.length) return { ...empty, title: "Why there are no picks right now", text: "No bet rates 7 or higher right now, so nothing is a pick. Ratings update with every new line.",
      leans: topPerGame(pool).slice(0, 5), sections: methodLines(bt).slice(0, 1) };
    return { ...empty, leans: picks, title: picks.length === 1 ? `Why ${pickText(picks[0].lean)} is the top pick` : `Why these are the best ${picks.length} picks`,
      text: "Each game's highest-rated bet that reaches 7 out of 10, with what the model sees in it. Ask about any team for its full game write-up.",
      sections: picks.map(({ game, lean }) => pickSection(game, lean, bt)),
      suggestions: picks.slice(0, 3).map(({ game }) => `Why is ${favorites(game).model.team} favored?`) };
  }
  if (/\b(ranked|featured|big games?|marquee)\b/.test(q)) {
    const leans = week.games.filter((g) => g.featured).flatMap((game) => game.markets.filter((m) => !market || m.market === market).map((lean) => ({ game, lean })));
    return { ...empty, title: "Featured games: each game's top-rated bet", leans: topPerGame(leans).slice(0, countOf(q, 15)) };
  }
  let pool = all.filter((x) => !market || x.lean.market === market);
  if (/\bunders?\b/.test(q)) pool = pool.filter((x) => x.lean.side === "under");
  if (/\bovers?\b/.test(q) && !/\bover\/under\b/.test(q)) pool = pool.filter((x) => x.lean.side === "over");
  if (upsetQ) {
    pool = pool.filter((x) => (x.lean.market === "moneyline" && (x.lean.price ?? 0) > 0) ||
      (x.lean.market === "spread" && (x.lean.line ?? 0) > 0));
    const dogs = week.games.filter((g) => g.upset && g.upset.p >= 0.25).sort((a, b) => (b.upset!.p - (b.upset!.market ?? b.upset!.p)) - (a.upset!.p - (a.upset!.market ?? a.upset!.p)));
    if (explain || /\b(chance|likely|best|top|biggest|most)\b/.test(q) || !pool.some((x) => isPick(x.lean))) {
      return { ...empty, title: "Upset watch", leans: topPerGame(pool.filter((x) => x.lean.market === "moneyline")).slice(0, 8),
        text: "Underdogs the simulations give a real chance, biggest gap over the market first. Only dogs in the moneyline value tier are picks.",
        sections: tidy([{ title: "Underdogs with a real chance", lines: dogs.slice(0, countOf(q, 8)).map((g) => {
          const u = g.upset!;
          return `${u.team}${u.price != null ? ` (${fmtPrice(u.price)})` : ""} vs ${u.side === "home" ? g.away : g.home}: wins ${pct0(u.p)} of simulations${u.market != null ? ` vs ${pct0(u.market)} implied by the price` : ""}${u.pick ? ". A pick (moneyline value tier)." : "."}`;
        }) }, ...(bt?.upsets?.value_bets ? [{ title: "How underdog value bets have done", lines: [
          `${bt.upsets.value_bets.n.toLocaleString()} moneyline value bets in testing (${pct0(bt.upsets.value_bets.dog_share)} on underdogs) won ${pct1(bt.upsets.value_bets.win)} and returned ${(bt.upsets.value_bets.roi * 100).toFixed(1)}¢ per $1; the chance that edge is real and not luck is about ${pct0(bt.upsets.value_bets.p_profit)}.`,
          ...bt.upsets.value_bets.by_price.map((b) => `${b.band}: ${b.n} bets, won ${pct1(b.win)}, ${(b.roi * 100).toFixed(1)}¢ per $1.`)] }] : [])]),
        suggestions: dogs.slice(0, 3).map((g) => `Can ${g.upset!.team} pull the upset?`) };
    }
  }
  const label = market ? `${MARKET_LABEL[market].toLowerCase()}s` : "bets";
  const wantPicks = /\b(best|picks?|bets?|lock|locks|top|strongest|confident)\b/.test(q);
  if (wantPicks) {
    // one bet per game (its highest rated), and only picks: rated 7+, the band that beat the books in testing
    const picks = topPerGame(pool.filter((x) => isPick(x.lean))).slice(0, countOf(q, 10));
    return { ...empty, leans: picks, title: `Best ${label} this week: rated 7+`,
      text: picks.length ? "Each game's highest-rated bet, only where it reaches 7 out of 10."
        : `No ${label} rate 7 or higher right now. Nothing is a pick until it does; ratings update with every new line.` };
  }
  return { ...empty, leans: topPerGame(pool).slice(0, countOf(q, 10)), title: `Highest-rated ${label} this week`,
    text: "Each game's highest-rated bet. Only 7+ are picks." };
}

/** One game's write-up as an answer: its bets by rating, the team rows, and the sections. */
function gameAnswer(g: CfbGame, ctx: { teams: Team[]; bt?: Backtest; props: PropRow[] }, market: CfbMarket | null, upset: boolean): AskAnswer {
  const leans = g.markets.filter((m) => !market || m.market === market).map((lean) => ({ game: g, lean })).sort(byRating);
  const ts = [g.away, g.home].map((n) => ctx.teams.find((t) => t.team === n)).filter((t): t is Team => !!t);
  const { model } = favorites(g);
  const fav = g.line.spread == null ? "no line yet" : g.line.spread <= 0 ? `${g.home} ${g.line.spread}` : `${g.away} ${-g.line.spread}`;
  return { leans, teams: ts, props: [], title: `${g.away} at ${g.home}`,
    text: `Line: ${fav}, total ${g.line.total ?? "–"}. Model: ${g.away} ${g.model.away.toFixed(1)}, ${g.home} ${g.model.home.toFixed(1)}; ${g.home} wins ${(g.model.home_win * 100).toFixed(0)}% of 5,000 simulations.`,
    sections: explainGame(g, ctx, { market, upset }),
    suggestions: [`Can ${model.dog} pull the upset?`, `${g.away} vs ${g.home} total`, `${model.team} spread`] };
}

/** A short "why" for one pick: the bet, the matchup edges behind it and its record. */
function pickSection(g: CfbGame, m: Lean, bt: Backtest | undefined): Section {
  const side = m.team_side ?? (m.team === g.home ? "home" : m.team === g.away ? "away" : null);
  const edges = ratingEdges(g).filter((e) => !e.neutral && (!side || e.leader === side)).slice(0, 3).map((e) => e.line);
  return { title: `${g.away} at ${g.home}: ${pickText(m)}`, lines: [...leanLines(m, g), ...(m.market === "total" || m.market === "team_total" ? [] : edges), ...trackRecord(m, bt)] };
}
