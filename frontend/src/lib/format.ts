import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function pct(v: unknown, digits = 0): string {
  return isNum(v) ? `${(v * 100).toFixed(digits)}%` : "—";
}

export function num(v: unknown, digits = 1): string {
  return isNum(v) ? v.toFixed(digits) : "—";
}

export function int(v: unknown): string {
  return isNum(v) ? Math.round(v).toLocaleString() : "—";
}

const CHICAGO = "America/Chicago";

/** ISO timestamp -> America/Chicago display. */
export function chicago(iso: string | null | undefined, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    timeZone: CHICAGO,
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" } : { year: "numeric" }),
  });
}

/** nflverse kickoff (date + ET clock) -> Chicago display. */
export function kickoff(gameday?: string | null, gametime?: string | null): string {
  if (!gameday) return "—";
  const [h, m] = (gametime || "13:00").split(":").map(Number);
  // Build the instant from Eastern wall-clock time by probing the ET offset for that date.
  const probe = new Date(`${gameday}T12:00:00Z`);
  const etHour = Number(probe.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const offset = 12 - etHour; // hours ET is behind UTC
  const utc = new Date(Date.UTC(+gameday.slice(0, 4), +gameday.slice(5, 7) - 1, +gameday.slice(8, 10), h + offset, m));
  return utc.toLocaleString("en-US", { timeZone: CHICAGO, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export function americanToProb(odds: string): number | null {
  const s = odds.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s) && s.includes(".")) {
    const d = parseFloat(s);
    return d > 1 ? 1 / d : null;
  }
  const a = parseFloat(s);
  if (!Number.isFinite(a) || (a > -100 && a < 100)) return null;
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}

export function decimalToProb(odds: string): number | null {
  const d = parseFloat(odds);
  return Number.isFinite(d) && d > 1 ? 1 / d : null;
}

export const POSITIONS = ["QB", "RB", "WR", "TE"] as const;
