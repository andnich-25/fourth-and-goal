/* College football write-ups: why the model favors a team, why it likes a bet, why a bet rates what it does, and the
   case for the upset. Every number is read from the published week, teams, props and backtest files; the only
   arithmetic is differences between two published numbers (a gap, a lead) so nothing new is estimated. */
import { MARKET_LABEL, bookName, fmtLine, fmtPrice, pickText, ranked, tierOf, type Backtest, type CfbGame, type CfbMarket, type Lean, type PropRow, type Team } from "./cfb";
import { cents, pct0, pct1, signed, tidy, type Section } from "./writeup";

export type ExplainCtx = { teams?: Team[]; bt?: Backtest; props?: PropRow[] };

const f1 = (v: number) => v.toFixed(1);
const byScore = (a: Lean, b: Lean) => b.score - a.score || (b.fair_p ?? b.p) - (a.fair_p ?? a.p);

/** Who the model and the books favor, and by how much. */
export function favorites(g: CfbGame) {
  const m = g.model.margin;
  const model = { team: m >= 0 ? g.home : g.away, dog: m >= 0 ? g.away : g.home, side: (m >= 0 ? "home" : "away") as "home" | "away",
    by: Math.abs(m), win: m >= 0 ? g.model.home_win : 1 - g.model.home_win };
  const s = g.line.spread;
  const book = s == null ? null : s === 0 ? { team: null, by: 0 } : { team: s < 0 ? g.home : g.away, by: Math.abs(s) };
  return { model, book };
}

type Stat = { key: keyof CfbGame["ratings"]["home"]; label: string; fmt: (v: number) => string; gap: (v: number) => string; lowerBetter?: boolean; neutral?: boolean };
const STATS: Stat[] = [
  { key: "pts_for", label: "Expected points in this game", fmt: f1, gap: (v) => `${f1(v)} points` },
  { key: "epa", label: "Expected EPA per play (garbage time out)", fmt: (v) => signed(v, 2), gap: (v) => `${v.toFixed(2)} EPA per play` },
  { key: "success", label: "Expected success rate", fmt: pct0, gap: (v) => `${Math.round(v * 100)} points of success rate` },
  { key: "ypp", label: "Expected yards per play", fmt: (v) => v.toFixed(2), gap: (v) => `${v.toFixed(2)} yards per play` },
  { key: "explosive", label: "Expected explosive-play rate", fmt: pct1, gap: (v) => `${(v * 100).toFixed(1)} points of explosive rate` },
  { key: "turnovers", label: "Expected turnovers (fewer is better)", fmt: (v) => v.toFixed(2), gap: (v) => `${v.toFixed(2)} turnovers`, lowerBetter: true },
  { key: "plays", label: "Expected plays (tempo)", fmt: (v) => v.toFixed(0), gap: (v) => `${v.toFixed(0)} plays`, neutral: true },
];

/** Each rating side by side, with who leads it. */
export function ratingEdges(g: CfbGame) {
  const out: { label: string; line: string; leader: "home" | "away" | null; neutral: boolean }[] = [];
  for (const s of STATS) {
    const h = g.ratings.home[s.key], a = g.ratings.away[s.key];
    if (h == null || a == null) continue;
    const d = h - a;
    const leader = d === 0 || s.neutral ? null : (d > 0) !== !!s.lowerBetter ? "home" : "away";
    const who = leader === "home" ? g.home : leader === "away" ? g.away : null;
    out.push({ label: s.label, leader, neutral: !!s.neutral,
      line: `${s.label}: ${g.away} ${s.fmt(a)}, ${g.home} ${s.fmt(h)}${who ? ` (${who} by ${s.gap(Math.abs(d))})` : s.neutral && d !== 0 ? ` (${d > 0 ? g.home : g.away} runs ${s.gap(Math.abs(d))} more)` : ""}.` });
  }
  return out;
}

export function teamLine(t: Team | undefined): string {
  if (!t) return "";
  return `${t.team}: ${t.w}-${t.l}, power rank ${t.power_rank}${t.net != null ? ` (net ${signed(t.net)} points against an average FBS team on a neutral field)` : ""}`
    + `${t.pts_for != null && t.pts_against != null ? `, rated to score ${f1(t.pts_for)} and allow ${f1(t.pts_against)}` : ""}`
    + `${t.ypp_for != null && t.ypp_against != null ? `, ${t.ypp_for.toFixed(2)} yards per play for and ${t.ypp_against.toFixed(2)} against` : ""}`
    + `, ${t.ats_w}-${t.ats_l}${t.ats_p ? `-${t.ats_p}` : ""} against the spread, games ${t.over}-${t.under} over/under.`;
}

/** How this kind of bet did in the walk-forward backtest: its confidence tier and its rating band. */
export function trackRecord(m: Lean, bt: Backtest | undefined): string[] {
  if (!bt) return [];
  const out: string[] = [];
  const rep = bt.markets[m.market];
  const t = tierOf(rep, m.tier);
  const label = MARKET_LABEL[m.market].toLowerCase();
  if (t) {
    out.push(m.market === "moneyline"
      ? `Moneyline bets in the ${t.tier} tier: ${t.n.toLocaleString()} past bets returned ${cents(t.roi ?? null)}${t.recent_roi != null ? ` (${cents(t.recent_roi)} in ${bt.recent_seasons.join("-")})` : ""}${t.rate != null ? `, winning ${pct1(t.rate)}` : ""}.`
      : `${MARKET_LABEL[m.market]} leans in the ${t.tier} tier: ${t.n.toLocaleString()} past games, won ${pct1(t.rate)}${t.recent_rate != null ? ` (${pct1(t.recent_rate)} in ${bt.recent_seasons.join("-")}, ${t.recent_n.toLocaleString()} games)` : ""}; break-even at -110 is ${pct1(bt.break_even)}.`);
    out.push(t.proven ? "That tier beat the price on seasons the model never saw, so it counts as proven." : `That tier did not beat the price in testing, so the rating is capped at 6.9 and it is not a pick.`);
  } else if (rep && !rep.proven) out.push(`${MARKET_LABEL[m.market]} leans as a whole did not beat the price in testing, so this one is not a pick.`);
  const band = bt.rating?.by_market?.[m.market]?.find((b) => m.score >= b.lo && (m.score < b.hi || b.hi >= 10));
  if (band && band.n) out.push(`Every past ${label} bet rated ${band.lo}–${band.hi >= 10 ? 10 : band.hi}: ${band.n.toLocaleString()} graded, won ${pct1(band.win)}, returned ${cents(band.roi)}${band.recent_roi != null ? ` (${cents(band.recent_roi)} in recent seasons)` : ""}.`);
  return out;
}

/** One bet in plain words: the rating and what it is made of. */
export function leanLines(m: Lean, g: CfbGame): string[] {
  const price = m.best?.price ?? m.price;
  const out = [`${pickText(m)}: rated ${m.score.toFixed(1)} out of 10${m.proven && m.score >= 7 ? ", a pick (7+)" : m.score >= 6.9 && !m.proven ? " (capped below 7: not proven in testing)" : ", below 7 so not a pick"}.`];
  out.push(`The 5,000 simulations give it ${pct1(m.p)}${m.push ? ` (pushes ${pct1(m.push)})` : ""}${m.fair_p != null ? `; similar leans in the past really won ${pct1(m.fair_p)}, so that is the chance the rating uses` : ""}`
    + `${m.ev != null ? `, worth ${cents(m.ev)} at ${price != null ? fmtPrice(price) : "-110"}${m.best?.book ? ` (${bookName(m.best.book)}, the best price we found)` : ""}` : ""}.`);
  if (m.market === "team_total" && !m.line_posted) out.push("This team total is implied from the spread and total, not posted by a book.");
  out.push(...m.reasons);
  if (m.market === "spread" && g.line.spread != null) {
    const cover = g.model.margin + g.line.spread; // > 0: home covers in the average simulated game
    out.push(`On average the simulated games finish ${Math.abs(cover).toFixed(1)} points on the ${cover >= 0 ? g.home : g.away} side of the number.`);
  }
  return out;
}

/** Why each outcome could miss: the honest case against. */
function against(g: CfbGame, top: Lean | undefined, bt: Backtest | undefined): string[] {
  const { model } = favorites(g);
  const out: string[] = [];
  out.push(`${model.dog} still wins ${pct0(1 - model.win)} of the 5,000 simulated games.`);
  const [lo, , hi] = g.model.margin_q;
  if (lo < 0 && hi > 0) out.push(`The middle 80% of simulated margins runs from ${g.away} by ${Math.abs(lo).toFixed(0)} to ${g.home} by ${hi.toFixed(0)}, so either team winning is a normal result.`);
  if (top) {
    if (top.fair_p != null && top.p - top.fair_p >= 0.02) out.push(`For ${pickText(top)}, past leans like it kept only part of the simulation's edge: ${pct1(top.p)} in the simulation became ${pct1(top.fair_p)} in real results.`);
    if ((top.fair_p ?? top.p) < 0.56 && top.market !== "moneyline") out.push(`Even the best bet here wins about ${pct0(top.fair_p ?? top.p)} of the time, so it loses about ${pct0(1 - (top.fair_p ?? top.p))}: a small edge that needs many bets to show up.`);
  }
  if (bt?.markets.spread && !bt.markets.spread.proven) out.push("Spread leans as a group did not beat the closing line in testing; only a spread lean in a proven tier can rate 7+ and count as a pick.");
  for (const side of ["home", "away"] as const) {
    const n = g.ratings[side].games;
    if (n != null && n < 4) out.push(`${side === "home" ? g.home : g.away} has only ${n} games in this season's ratings, so they lean on last season.`);
  }
  if (!g.model.line_based) out.push("No line is posted yet, so the projection comes from team ratings alone.");
  out.push(...(g.notes ?? []));
  return out;
}

/** The underdog's case: model vs market, how dogs like it really did, and where it holds an edge. */
export function upsetLines(g: CfbGame, bt: Backtest | undefined): string[] {
  const u = g.upset;
  if (!u) return [];
  const out = [`${u.team} wins ${pct0(u.p)} of the simulations${u.market != null ? `; the moneyline${u.price != null ? ` (${fmtPrice(u.price)})` : ""} implies ${pct0(u.market)} once the book's cut is removed` : ""}.`
    + (u.market != null ? ` The model is ${u.p > u.market ? "higher" : "lower"} on the upset by ${Math.abs(Math.round((u.p - u.market) * 100))} points.` : "")];
  const bin = bt?.upsets?.calibration.find((b) => u.p >= b.lo && u.p < b.hi);
  if (bin) out.push(`When the model gave an underdog ${Math.round(bin.lo * 100)}–${Math.round(bin.hi * 100)}%, those dogs really won ${pct1(bin.actual)} (${bin.n.toLocaleString()} games; the market had them at ${pct1(bin.market)}).`);
  const leads = ratingEdges(g).filter((e) => e.leader === u.side).map((e) => e.label.replace(/^Expected /, "").replace(/ \(.*\)$/, "").toLowerCase());
  if (leads.length) out.push(`Where ${u.team} rates better: ${leads.join(", ")}.`);
  const dr = bt?.upsets?.drivers;
  if (dr?.rows.length) {
    const top = [...dr.rows].sort((a, b) => (b.upsets - b.others) - (a.upsets - a.others)).slice(0, 2);
    out.push(`In past games with a ${dr.min_line}+ point underdog, the dogs that won ${top.map((r) => `${r.driver.toLowerCase()} ${pct0(r.upsets)} of the time (${pct0(r.others)} when they lost)`).join(", and ")}.`);
  }
  out.push(u.pick ? "The gap is big enough to fall in the moneyline value tier, which made money in testing: this upset is a pick." : "It is not a pick: the gap is not in the tier that made money in testing.");
  return out;
}

/** The full write-up for one game. focus: a market or team the question named, explained first. */
export function explainGame(g: CfbGame, ctx: ExplainCtx = {}, focus: { market?: CfbMarket | null; upset?: boolean } = {}): Section[] {
  const { model, book } = favorites(g);
  const leans = [...g.markets].sort(byScore);
  const order = focus.market ? [...leans.filter((m) => m.market === focus.market), ...leans.filter((m) => m.market !== focus.market)] : leans;
  const top = order[0];
  const tm = (name: string) => ctx.teams?.find((t) => t.team === name);
  const edges = ratingEdges(g);
  const favSide = model.side;
  const favLeads = edges.filter((e) => e.leader === favSide).length, counted = edges.filter((e) => !e.neutral).length;

  const short: string[] = [];
  short.push(model.by < 1 ? `The model has this as a toss-up: ${g.away} ${f1(g.model.away)}, ${g.home} ${f1(g.model.home)}, and ${g.home} wins ${pct0(g.model.home_win)} of 5,000 simulated games.`
    : `The model favors ${model.team} by ${f1(model.by)} (${g.away} ${f1(g.model.away)}, ${g.home} ${f1(g.model.home)}); ${model.team} wins ${pct0(model.win)} of 5,000 simulated games.`);
  if (!book) short.push("No book line is posted yet.");
  else if (book.team == null) short.push("The books have it as a pick'em.");
  else if (book.team === model.team) {
    const d = model.by - book.by;
    short.push(Math.abs(d) < 1 ? `The books agree: ${book.team} ${fmtLine(-book.by)}, within ${Math.abs(d).toFixed(1)} of the model, so there is little spread edge.`
      : `The books agree: ${book.team} ${fmtLine(-book.by)}. The model likes ${book.team} by ${Math.abs(d).toFixed(1)} ${d >= 0 ? "more" : "less"} than the line, which is why it leans ${d >= 0 ? book.team : model.dog} against the spread.`);
  } else short.push(`The model disagrees with the books, which have ${book.team} ${fmtLine(-book.by)}: it thinks ${model.team} is the better team in this game.`);
  if (top) short.push(`Best bet in this game: ${pickText(top)}, rated ${top.score.toFixed(1)} out of 10${top.proven && top.score >= 7 ? " (a pick)" : " (not a pick: picks need 7+)"}.`);

  const why: string[] = [];
  if (counted) why.push(`${model.team} has the better expected number in ${favLeads} of ${counted} parts of the game, opponent-adjusted and refit before this week (the last two seasons count most).`);
  why.push(...edges.map((e) => e.line));
  if (!g.neutral) why.push(`${g.home} is at home${g.venue ? ` (${g.venue})` : ""}; home field is part of the rating fit.`);
  else why.push(`Neutral site${g.venue ? ` (${g.venue})` : ""}: no home field.`);
  if (g.home_rank || g.away_rank) why.push(`AP ranks: ${ranked(g.away, g.away_rank)}, ${ranked(g.home, g.home_rank)}. Ranks are not a model input; the ratings are.`);

  const season = [teamLine(tm(g.away)), teamLine(tm(g.home))];
  const ta = tm(g.away), th = tm(g.home);
  if (ta?.net != null && th?.net != null) season.push(`Their season-long net ratings differ by ${Math.abs(th.net - ta.net).toFixed(1)} points in ${th.net >= ta.net ? g.home : g.away}'s favor before home field and this game's matchup.`);

  const score = [`Projected score: ${g.away} ${f1(g.model.away)}, ${g.home} ${f1(g.model.home)}.`,
    `Total: model ${f1(g.model.total)}${g.line.total != null ? ` vs the line ${g.line.total}` : ""}; 80% of simulated games land between ${g.model.total_q[0]} and ${g.model.total_q[2]} points.`,
    `Margin: 80% of simulated games land between ${g.model.margin_q[0] >= 0 ? `${g.home} by ${g.model.margin_q[0]}` : `${g.away} by ${-g.model.margin_q[0]}`} and ${g.model.margin_q[2] >= 0 ? `${g.home} by ${g.model.margin_q[2]}` : `${g.away} by ${-g.model.margin_q[2]}`}.`,
    "Each simulated game adds a miss drawn from the model's real misses on games it had not seen (about the last two seasons) to the projected score."];

  const bets = order.flatMap((m, i) => (i < 4 ? leanLines(m, g) : []));
  const record = top ? [...trackRecord(top, ctx.bt), "The rating ranks this bet's expected return (the calibrated chance at the best price) against every lean in the backtest: 8 means better than 80% of them. 7+ is the band that beat the books on seasons the model never saw."] : [];
  const props = (ctx.props ?? []).filter((r) => r.game_id === g.game_id).sort((a, b) => b.score - a.score).slice(0, 4)
    .map((r) => `${r.player} (${r.team}) ${r.side} ${r.line} ${r.label.toLowerCase()}: projects ${f1(r.mean)}, recent games ${r.recent.slice(0, 5).join(", ") || "none"}, rated ${r.score.toFixed(1)}/10${r.line_source === "book" ? "" : " at his usual line (no book line)"}.`);

  const upset = upsetLines(g, ctx.bt);
  return tidy([
    { title: "The short answer", lines: short },
    ...(focus.upset && upset.length ? [{ title: `The upset case for ${g.upset!.team}`, lines: upset }] : []),
    { title: `Why ${model.by < 1 ? "it is close" : `${model.team} is favored`}`, lines: why },
    { title: "Season so far", lines: season },
    { title: "Projected score from 5,000 simulations", lines: score },
    { title: focus.market ? `The ${MARKET_LABEL[focus.market].toLowerCase()} and the other bets` : "Every bet in this game", lines: bets },
    { title: "Track record behind the rating", lines: record },
    ...(!focus.upset && upset.length ? [{ title: `The upset case for ${g.upset!.team}`, lines: upset }] : []),
    { title: "What could go wrong", lines: against(g, top, ctx.bt) },
    { title: "Players to watch", lines: props },
  ]);
}

/** Two teams that do not play each other this week: their season ratings side by side. */
export function compareTeams(a: Team, b: Team): Section[] {
  const rows: string[] = [teamLine(a), teamLine(b)];
  if (a.net != null && b.net != null) {
    const better = a.net >= b.net ? a : b, worse = better === a ? b : a;
    rows.push(`On a neutral field ${better.team} would be favored by about ${Math.abs(a.net - b.net).toFixed(1)} points (the gap in net rating).`);
    if (better.pts_for != null && worse.pts_for != null) rows.push(`Offense: ${better.team} is rated to score ${f1(better.pts_for)} against an average team, ${worse.team} ${f1(worse.pts_for)}.`);
    if (better.pts_against != null && worse.pts_against != null) rows.push(`Defense: ${better.team} is rated to allow ${f1(better.pts_against)}, ${worse.team} ${f1(worse.pts_against)}.`);
  }
  return tidy([{ title: `${a.team} vs ${b.team} on paper`, lines: rows },
    { title: "Note", lines: ["They do not play each other this week, so there is no simulation or bet for this matchup. These are each team's season ratings, opponent-adjusted, with the last two seasons counting most."] }]);
}

/** How the ratings and picks are made, with the published test results. */
export function methodLines(bt: Backtest | undefined): Section[] {
  const lines = [
    "Each team gets opponent-adjusted ratings for points, yards per play, plays, turnovers, EPA per play, success rate and explosive plays, refit before every week from every game since the first season in the data, with recent games counting most.",
    `Every game is then played out ${bt?.model.sims.toLocaleString() ?? "5,000"} times: the projected score plus a miss drawn from the model's real misses on games it had not seen.`,
    "Each bet's simulated chance is calibrated on how similar leans really did, priced at the best odds on offer, and ranked against every past lean to give the rating out of 10.",
    "Only markets and tiers that beat the price on seasons the model never saw can rate 7 or higher; everything else is capped at 6.9 and shown for reference.",
  ];
  const record: string[] = [];
  if (bt) {
    for (const [m, r] of Object.entries(bt.markets)) {
      const best = r.tiers.filter((t) => t.proven).map((t) => t.tier);
      record.push(`${MARKET_LABEL[m as CfbMarket]}: ${r.n.toLocaleString()} graded games${r.rate != null ? `, ${pct1(r.rate)} won` : ""}${r.roi != null ? `, ${cents(r.roi)}` : ""}; ${best.length ? `proven tiers: ${best.join(", ")}` : "no tier beat the price"}.`);
    }
    for (const b of bt.rating?.bands ?? []) if (b.n) record.push(`Rated ${b.lo}–${b.hi}: ${b.n.toLocaleString()} bets, won ${pct1(b.win)}, ${cents(b.roi)}${b.recent_roi != null ? ` (${cents(b.recent_roi)} recently)` : ""}.`);
  }
  return tidy([{ title: "How the picks are made", lines }, { title: `Backtest ${bt ? `${bt.first_season}–${bt.last_season}` : ""}`.trim(), lines: record }]);
}
