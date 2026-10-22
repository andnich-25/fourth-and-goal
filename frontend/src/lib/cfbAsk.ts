/* College football Ask: plain-English questions answered only from the published week, teams and props files.
   It never invents a number: every answer is a list of published leans, teams or props. */
import { MARKET_LABEL, type CfbGame, type CfbMarket, type Lean, type PropRow, type Team, type Week } from "./cfb";

export type AskLean = { game: CfbGame; lean: Lean };
export type AskAnswer = { title: string; text?: string; leans: AskLean[]; teams: Team[]; props: PropRow[] };

export const SUGGESTIONS = ["Best picks this week", "Best unders", "Biggest overs", "Alabama spread", "Upset picks", "Top 10 teams",
  "Best teams against the spread", "Passing yards props", "Ranked matchups"];

const MARKETS: [RegExp, CfbMarket][] = [
  [/\bteam totals?\b/, "team_total"],
  [/\b(totals?|over\/under|o\/u|overs?|unders?|points scored)\b/, "total"],
  [/\b(spreads?|ats|cover|covers|line)\b/, "spread"],
  [/\b(moneylines?|ml|to win|outright|upsets?)\b/, "moneyline"],
];
const PROP_WORDS: [RegExp, string][] = [
  [/\bpass(ing)?\b/, "pass_yds"], [/\brush(ing)?\b/, "rush_yds"], [/\b(receiving|rec)\b/, "rec_yds"], [/\b(receptions|catches)\b/, "receptions"],
];

function teamIn(q: string, names: string[]): string | null {
  let best: string | null = null;
  for (const n of names) {
    const re = new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(q) && (!best || n.length > best.length)) best = n;
  }
  return best;
}
const countOf = (q: string, d: number) => Math.min(25, Number(q.match(/\btop (\d+)\b/)?.[1] || q.match(/\b(\d+) (picks|games|teams|bets)\b/)?.[1]) || d);

export function answer(question: string, week: Week, teams: Team[] = [], props: PropRow[] = []): AskAnswer {
  const q = question.toLowerCase().trim();
  const all: AskLean[] = week.games.flatMap((game) => game.markets.map((lean) => ({ game, lean })));
  const market = MARKETS.find(([re]) => re.test(q))?.[1] ?? null;
  const names = [...new Set([...week.games.flatMap((g) => [g.home, g.away]), ...teams.map((t) => t.team)])];
  const team = teamIn(q, names);
  const empty = { leans: [], teams: [], props: [] };

  // props
  const pm = PROP_WORDS.find(([re]) => re.test(q))?.[1];
  if (/\bprops?\b/.test(q) || (pm && /\byards|yds|props?|receptions|catches\b/.test(q))) {
    const rows = props.filter((r) => (!pm || r.market === pm) && (!team || r.team === team || r.opp === team)).sort((a, b) => b.p - a.p);
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
  // one team
  if (team) {
    const games = week.games.filter((g) => g.home === team || g.away === team);
    const t = teams.find((x) => x.team === team);
    if (!games.length) return { ...empty, title: team, teams: t ? [t] : [], text: "No game this week." };
    const g = games[0];
    const leans = g.markets.filter((m) => !market || m.market === market).map((lean) => ({ game: g, lean }));
    const fav = g.line.spread == null ? "no line yet" : g.line.spread <= 0 ? `${g.home} ${g.line.spread}` : `${g.away} ${-g.line.spread}`;
    return { ...empty, title: `${g.away} at ${g.home}`, leans, teams: t ? [t] : [],
      text: `Line: ${fav}, total ${g.line.total ?? "–"}. Model: ${g.away} ${g.model.away.toFixed(1)}, ${g.home} ${g.model.home.toFixed(1)}; ${g.home} wins ${(g.model.home_win * 100).toFixed(0)}% of 5,000 simulations.` };
  }
  if (/\b(ranked|featured|big games?|marquee)\b/.test(q)) {
    const leans = week.games.filter((g) => g.featured).flatMap((game) => game.markets.filter((m) => !market || m.market === market).map((lean) => ({ game, lean })));
    return { ...empty, title: "Featured games", leans: leans.sort((a, b) => b.lean.p - a.lean.p).slice(0, countOf(q, 15)) };
  }
  let pool = all.filter((x) => !market || x.lean.market === market);
  if (/\bunders?\b/.test(q)) pool = pool.filter((x) => x.lean.side === "under");
  if (/\bovers?\b/.test(q) && !/\bover\/under\b/.test(q)) pool = pool.filter((x) => x.lean.side === "over");
  if (/\b(upsets?|underdogs?|dogs?)\b/.test(q)) {
    pool = pool.filter((x) => (x.lean.market === "moneyline" && (x.lean.price ?? 0) > 0) ||
      (x.lean.market === "spread" && (x.lean.line ?? 0) > 0));
  }
  const proven = pool.filter((x) => x.lean.proven);
  const wantPicks = /\b(best|picks?|bets?|lock|locks|top|strongest|confident)\b/.test(q);
  const list = (wantPicks && proven.length ? proven : pool).sort((a, b) => b.lean.p - a.lean.p).slice(0, countOf(q, 10));
  const label = market ? MARKET_LABEL[market].toLowerCase() : "leans";
  return { ...empty, leans: list,
    title: wantPicks && proven.length ? `Best ${label} (proven tiers)` : `Strongest ${label} this week`,
    text: wantPicks && !proven.length ? `No ${label} reach a proven tier, so these are the strongest leans, for reference only.` : undefined };
}
