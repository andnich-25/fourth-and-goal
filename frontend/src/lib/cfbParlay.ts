/* College football parlays: legs from this week's game lines (the side the model likes) and props at book-posted lines.
   A leg's chance is its calibrated chance (fair_p). Legs from different games multiply; legs from the same game are
   priced from that game's simulated scores, so a favorite covering and the over (which tend to go together) are not
   treated as independent. Props are treated as independent of everything else. */
import { decodeSims, pickText, type CfbGame, type Lean, type PropRow, type Sims } from "./cfb";

export type Leg = {
  id: string; game_id: number; kind: "line" | "prop"; label: string; sub: string; market: string;
  p: number; fair: number; score: number; ev: number | null; proven: boolean; price: number; book: string | null; lean?: Lean;
};

export const decimal = (american: number) => 1 + (american > 0 ? american / 100 : 100 / -american);
export const americanOf = (d: number) => (d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`);

export function lineLegs(games: CfbGame[]): Leg[] {
  const out: Leg[] = [];
  for (const g of games) {
    if (!g.line.has_line) continue;
    for (const m of g.markets) {
      if (m.market === "team_total" && !m.line_posted) continue;     // only lines books post
      const price = m.best?.price ?? m.price ?? -110;
      out.push({ id: `${g.game_id}-${m.market}-${m.team_side ?? ""}`, game_id: g.game_id, kind: "line", label: pickText(m),
        sub: `${g.away} at ${g.home}`, market: m.market, p: m.p, fair: m.fair_p ?? m.p, score: m.score, ev: m.ev ?? null,
        proven: m.proven, price, book: m.best?.book ?? null, lean: m });
    }
  }
  return out;
}

export function propLegs(rows: PropRow[], games: CfbGame[]): Leg[] {
  const byId = new Map(games.map((g) => [g.game_id, g]));
  return rows.filter((r) => r.line_source === "book").map((r) => {
    const g = byId.get(r.game_id);
    return { id: `p-${r.player_id}-${r.market}`, game_id: r.game_id, kind: "prop" as const,
      label: `${r.player} ${r.side} ${r.line} ${r.label.toLowerCase()}`, sub: g ? `${g.away} at ${g.home}` : r.team, market: r.market,
      p: r.p, fair: r.fair_p ?? r.p, score: r.score, ev: r.ev ?? null, proven: r.proven, price: r.best?.price ?? -110, book: r.best?.book ?? null };
  });
}

/** 1 win, 0 loss, null push, for one simulated score. */
export function legResult(m: Lean, h: number, a: number): 1 | 0 | null {
  const home = (m.team_side ?? m.side) === "home";
  let d: number;
  if (m.market === "spread") d = (home ? h - a : a - h) + (m.line ?? 0);
  else if (m.market === "total") d = (m.side === "over" ? 1 : -1) * (h + a - (m.line ?? 0));
  else if (m.market === "team_total") d = (m.side === "over" ? 1 : -1) * ((home ? h : a) - (m.line ?? 0));
  else d = home ? h - a : a - h;
  return d > 0 ? 1 : d < 0 ? 0 : null;
}

/** Chance all legs win in one game's simulations (pushed draws left out), and the same legs as if independent. */
export function sameGame(legs: Lean[], sims: string): { joint: number; independent: number; n: number } {
  const { h, a } = decodeSims(sims);
  let n = 0, all = 0;
  const wins = legs.map(() => 0), seen = legs.map(() => 0);
  for (let i = 0; i < h.length; i++) {
    const r = legs.map((m) => legResult(m, h[i], a[i]));
    r.forEach((x, j) => { if (x != null) { seen[j]++; wins[j] += x; } });
    if (r.some((x) => x == null)) continue;
    n++;
    if (r.every((x) => x === 1)) all++;
  }
  const independent = wins.reduce((acc, w, j) => acc * (seen[j] ? w / seen[j] : 0.5), 1);
  return { joint: n ? all / n : independent, independent, n };
}

export type Priced = {
  chance: number; independentChance: number; decimal: number; ev: number;
  groups: { game_id: number; legs: number; lift: number }[];
};

/** Parlay chance (calibrated, same-game legs from the simulations), payout and expected return per $1. */
export function priceParlay(legs: Leg[], sims: Sims | undefined): Priced {
  const byGame = new Map<number, Leg[]>();
  for (const l of legs) byGame.set(l.game_id, [...(byGame.get(l.game_id) ?? []), l]);
  let chance = 1, independentChance = 1;
  const groups: Priced["groups"] = [];
  for (const [gid, ls] of byGame) {
    const fairAll = ls.reduce((acc, l) => acc * l.fair, 1);
    independentChance *= fairAll;
    const lines = ls.filter((l) => l.kind === "line" && l.lean);
    const s = sims?.games[String(gid)];
    let lift = 1;
    if (lines.length >= 2 && s) {
      const sg = sameGame(lines.map((l) => l.lean!), s);
      lift = sg.independent > 0 ? sg.joint / sg.independent : 1;
      groups.push({ game_id: gid, legs: lines.length, lift });
    }
    chance *= Math.min(1, fairAll * lift);
  }
  const dec = legs.reduce((acc, l) => acc * decimal(l.price), 1);
  return { chance, independentChance, decimal: dec, ev: chance * dec - 1, groups };
}

/** The best parlay of `size` legs, one per game, from proven legs rated 7+ (highest rating first). */
export function suggest(legs: Leg[], size: number): Leg[] {
  const used = new Set<number>();
  const out: Leg[] = [];
  for (const l of [...legs].filter((x) => x.proven && x.score >= 7).sort((x, y) => y.score - x.score)) {
    if (used.has(l.game_id)) continue;
    used.add(l.game_id);
    out.push(l);
    if (out.length === size) break;
  }
  return out;
}
