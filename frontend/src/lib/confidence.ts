/* Confidence tiers: plain-language bands with how often past walk-forward picks in each band actually hit. */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type Tier = { tier: string; lo: number; hi: number; n: number; hits: number; rate: number | null; avg_chance: number | null; ci: [number | null, number | null] };
export type Confidence = {
  td: { model: string; weeks: number; first_season: number; tiers: Tier[] } | null;
  props: { weeks: number; first_season: number; tiers: Tier[]; note: string } | null;
};

export function useConfidence() {
  return useQuery({ queryKey: ["confidence"], queryFn: () => api.get<Confidence>("/backtest/confidence"), staleTime: 5 * 60_000 });
}

/** The tier a chance falls in. Props use the chance of the side picked (always ≥ 50%). */
export function tierFor(c: Confidence | undefined, kind: "td" | "props", p: number | null | undefined): Tier | null {
  if (p == null || !c) return null;
  const t = kind === "td" ? c.td : c.props;
  return t?.tiers.find((x) => p >= x.lo && p < (x.hi >= 1 ? 1.01 : x.hi)) ?? null;
}

export const tierTone = (name?: string) => (name === "Strong" ? "ok" : name === "Solid" ? "accent" : name === "Lean" ? "neutral" : "warn") as
  "ok" | "accent" | "neutral" | "warn";
