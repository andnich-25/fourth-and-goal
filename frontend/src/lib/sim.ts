/* Parlay simulation. Mirrors backend/engine/correlation.py: each leg hits when a standard-normal draw falls below the
   normal quantile of its validated chance; legs from the same game share the correlation learned for their relationship
   (same player, teammates, opponents) and markets; legs from different games are independent. */

export type Side = "yes" | "over" | "under";
export type SimLeg = { id: string; market: string; player_id: string; team: string; position: string; game_id: string; p: number; side: Side };
export type Buckets = Record<string, { rho: number; pairs: number }>;
export type SimResult = {
  draws: number; joint: number; se: number; independent: number;
  hits: number[]; // hits[k] = chance exactly k legs hit
  conditional: (number | null)[]; // chance leg i hits given every other leg hit
  marginals: number[];
};

export function bucketKeys(rel: "player" | "team" | "opp", ma: string, pa: string, mb: string, pb: string): [string, string, string] {
  if (rel === "player") {
    const [m1, m2] = [ma, mb].sort();
    return [`player|${m1}|${m2}`, `player|${m1}|${m2}`, "player"];
  }
  // Same order as Python's sorted() on (market, position) tuples.
  const [[m1, p1], [m2, p2]] = [[ma, pa], [mb, pb]].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  return [`${rel}|${m1}.${p1}|${m2}.${p2}`, `${rel}|${m1}|${m2}`, rel];
}

export function relation(a: SimLeg, b: SimLeg): "player" | "team" | "opp" | null {
  if (a.game_id !== b.game_id) return null;
  return a.player_id === b.player_id ? "player" : a.team === b.team ? "team" : "opp";
}

/** Correlation between two legs' latent draws (an "under" leg is the mirror image of its over). */
export function rhoFor(a: SimLeg, b: SimLeg, buckets: Buckets): number {
  const rel = relation(a, b);
  if (!rel) return 0;
  const [leaf, parent, root] = bucketKeys(rel, a.market, a.position, b.market, b.position);
  const rho = buckets[leaf]?.rho ?? buckets[parent]?.rho ?? buckets[root]?.rho ?? 0;
  return (a.side === "under") !== (b.side === "under") ? -rho : rho;
}

// ---------------------------------------------------------------------------- numerics
export function normInv(p: number): number {
  // Acklam's rational approximation (|error| < 1.2e-9).
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const q = Math.min(Math.max(p, 1e-10), 1 - 1e-10);
  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  if (q > 1 - 0.02425) return -normInv(1 - q);
  const r = q - 0.5, s = r * r;
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

export function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let spare: number | null = null;
  return () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let x = 0, y = 0;
    while (x === 0) x = u();
    y = u();
    const r = Math.sqrt(-2 * Math.log(x));
    spare = r * Math.sin(2 * Math.PI * y);
    return r * Math.cos(2 * Math.PI * y);
  };
}

/** Lower Cholesky factor; off-diagonals are shrunk toward 0 until the matrix is positive definite. */
export function cholesky(R: number[][]): number[][] {
  const n = R.length;
  for (let shrink = 1; shrink > 0; shrink -= 0.05) {
    const L = Array.from({ length: n }, () => new Array(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = (i === j ? 1 : R[i][j] * shrink);
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 1e-9) { ok = false; break; } L[i][i] = Math.sqrt(s); }
        else L[i][j] = s / L[j][j];
      }
    }
    if (ok) return L;
  }
  return R.map((_, i) => R.map((__, j) => (i === j ? 1 : 0)));
}

export function corrMatrix(legs: SimLeg[], buckets: Buckets, useCorrelation: boolean): number[][] {
  return legs.map((a, i) => legs.map((b, j) => (i === j ? 1 : useCorrelation ? rhoFor(a, b, buckets) : 0)));
}

export function simulate(legs: SimLeg[], buckets: Buckets, useCorrelation: boolean, draws = 40000, seed = 20261022): SimResult {
  const n = legs.length;
  const independent = legs.reduce((a, l) => a * l.p, 1);
  if (!n) return { draws: 0, joint: 0, se: 0, independent: 0, hits: [1], conditional: [], marginals: [] };
  const L = cholesky(corrMatrix(legs, buckets, useCorrelation));
  const th = legs.map((l) => normInv(l.p));
  const g = rng(seed);
  const hitsCount = new Array(n + 1).fill(0);
  const marg = new Array(n).fill(0);
  const allButOne = new Array(n).fill(0); // draws where every leg except i hit
  let all = 0;
  const z = new Array(n).fill(0), hit = new Array(n).fill(false);
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < n; i++) z[i] = g();
    let k = 0;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let j = 0; j <= i; j++) x += L[i][j] * z[j];
      hit[i] = x < th[i];
      if (hit[i]) { k++; marg[i]++; }
    }
    hitsCount[k]++;
    if (k === n) all++;
    if (k === n - 1) for (let i = 0; i < n; i++) if (!hit[i]) allButOne[i]++;
  }
  const joint = all / draws;
  return {
    draws, joint, se: Math.sqrt(Math.max(joint * (1 - joint), 1e-12) / draws), independent,
    hits: hitsCount.map((c) => c / draws),
    conditional: legs.map((_, i) => (all + allButOne[i] > 0 ? all / (all + allButOne[i]) : null)),
    marginals: marg.map((c) => c / draws),
  };
}

/** Every pair's chance of both hitting, from one shared set of draws (for the game simulator). */
export function coHits(legs: SimLeg[], buckets: Buckets, useCorrelation: boolean, draws = 30000, seed = 7): { marginals: number[]; both: number[][] } {
  const n = legs.length;
  const L = cholesky(corrMatrix(legs, buckets, useCorrelation));
  const th = legs.map((l) => normInv(l.p));
  const g = rng(seed);
  const both = Array.from({ length: n }, () => new Array(n).fill(0));
  const z = new Array(n).fill(0), hit = new Array(n).fill(false);
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < n; i++) z[i] = g();
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let j = 0; j <= i; j++) x += L[i][j] * z[j];
      hit[i] = x < th[i];
    }
    for (let i = 0; i < n; i++) if (hit[i]) for (let j = i; j < n; j++) if (hit[j]) both[i][j]++;
  }
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { both[i][j] /= draws; both[j][i] = both[i][j]; }
  return { marginals: both.map((r, i) => r[i]), both };
}

// ---------------------------------------------------------------------------- odds
export function toDecimal(odds: string): number | null {
  const s = odds.trim();
  if (!s) return null;
  if (s.includes(".") && /^\d+(\.\d+)?$/.test(s)) { const d = parseFloat(s); return d > 1 ? d : null; }
  const a = parseFloat(s);
  if (!Number.isFinite(a) || (a > -100 && a < 100)) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

export function toAmerican(dec: number): string {
  if (!(dec > 1)) return "—";
  return dec >= 2 ? `+${Math.round((dec - 1) * 100)}` : `${Math.round(-100 / (dec - 1))}`;
}

/** Best (highest-paying) price among the books that have one. */
export function bestPrice(prices: Record<string, string>): { book: string; decimal: number } | null {
  let best: { book: string; decimal: number } | null = null;
  for (const [book, s] of Object.entries(prices)) {
    const d = toDecimal(s ?? "");
    if (d && (!best || d > best.decimal)) best = { book, decimal: d };
  }
  return best;
}
