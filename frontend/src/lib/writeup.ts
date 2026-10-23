/* A write-up: the detailed answer to "why" questions (why is this team favored, why this pick, why this rating).
   Each section is a heading and plain sentences built only from published numbers; the Ask pages render them and the
   AI mode receives them as tool results. */
export type Section = { title: string; lines: string[] };

/** Drops empty lines and empty sections. */
export const tidy = (s: Section[]): Section[] => s.map((x) => ({ ...x, lines: x.lines.filter(Boolean) })).filter((x) => x.lines.length);

export const pct0 = (p: number | null | undefined) => (p == null ? "–" : `${Math.round(p * 100)}%`);
export const pct1 = (p: number | null | undefined) => (p == null ? "–" : `${(p * 100).toFixed(1)}%`);
export const signed = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
export const cents = (ev: number | null | undefined) => (ev == null ? "–" : `${ev >= 0 ? "+" : "−"}${Math.abs(ev * 100).toFixed(1)}¢ per $1`);
