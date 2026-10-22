/* Sportsbook prices fetched by the engine (engine/odds.py), indexed for the builder and the props page. */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type OddsRow = { market: string; player_id: string; book: string; side: string; line: number | null; price: number };
export type OddsResp = { fetched_at: string | null; source?: string; rows: OddsRow[]; empty_reason?: string };
export type Feed = { at: string | null; get: (market: string, playerId: string, side: string) => OddsRow[] };

export function useFeed(season: number, week: number): Feed {
  const q = useQuery({ queryKey: ["odds", season, week], queryFn: () => api.get<OddsResp>("/odds", { season, week }) });
  return React.useMemo(() => {
    const idx = new Map<string, OddsRow[]>();
    for (const r of q.data?.rows ?? []) {
      const k = `${r.market}:${r.player_id}:${r.side}`;
      idx.set(k, [...(idx.get(k) ?? []), r]);
    }
    return { at: q.data?.fetched_at ?? null, get: (m, p, s) => idx.get(`${m}:${p}:${s}`) ?? [] };
  }, [q.data]);
}
/** Most common line the books offer (the one prices can be compared at). */
export function feedLine(feed: Feed, market: string, playerId: string): number | null {
  const n = new Map<number, number>();
  for (const r of feed.get(market, playerId, "over")) if (r.line != null) n.set(r.line, (n.get(r.line) ?? 0) + 1);
  let best: number | null = null, c = 0;
  n.forEach((v, k) => { if (v > c) { best = k; c = v; } });
  return best;
}
