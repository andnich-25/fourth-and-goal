/* Over/under chance for any line, from the predictive distribution the engine publishes.
   Mirrors Distribution.p_over in backend/engine/props.py (including its over/under recalibration). */

export type PropDist =
  | { type: "nbinom"; n: number; p: number; cdf: number[]; platt: [number, number] }
  | { type: "quantiles"; q: number[]; platt: [number, number] };

const clamp = (x: number) => Math.min(0.995, Math.max(0.005, x));
const logit = (p: number) => { const c = clamp(p); return Math.log(c / (1 - c)); };

function rawOver(d: PropDist, line: number): number {
  if (d.type === "nbinom") {
    const k = Math.floor(line);
    if (k < 0) return 0.995;
    if (k >= d.cdf.length) return 0.005;
    return clamp(1 - d.cdf[k]);
  }
  const q = d.q;
  if (line < q[0]) return 0.995;
  if (line >= q[q.length - 1]) return 0.005;
  // Same rule as the engine: the CDF is interpolated linearly through the 1%..99% quantiles.
  let j = 0;
  while (j < q.length && q[j] <= line) j++;
  const lo = q[j - 1], hi = q[j];
  const fLo = j / 100, fHi = (j + 1) / 100;
  const f = fLo + (fHi - fLo) * (hi > lo ? (line - lo) / (hi - lo) : 1);
  return clamp(1 - f);
}

/** Validated P(result > line). Book lines end in .5, so a push is impossible. */
export function pOver(d: PropDist, line: number): number {
  const [a, b] = d.platt ?? [1, 0];
  return clamp(1 / (1 + Math.exp(-(a * logit(rawOver(d, line)) + b))));
}

export const MARKET_GROUPS: { label: string; markets: string[] }[] = [
  { label: "Passing", markets: ["pass_yards", "pass_attempts", "completions", "pass_tds", "interceptions"] },
  { label: "Rushing", markets: ["rush_yards", "carries"] },
  { label: "Receiving", markets: ["rec_yards", "receptions", "rush_rec_yards"] },
];
