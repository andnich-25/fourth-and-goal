/* Every pick the site showed, frozen at kickoff and graded after the game (engine/picklog.py, /backtest/live). */
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { api } from "@/lib/api";
import { num, pct } from "@/lib/format";
import { Card, CardBody, CardHeader, Stat, TableWrap, Td, Th } from "@/components/ui";

type S = { n: number; hits: number; rate: number | null; avg_chance: number | null; ci: [number | null, number | null] | null; drift: string | null };
type WeekRow = { season: number; week: number; picks: number; graded: number; void: number; pending: number; featured: S; all: S };
export type LiveRecord = {
  available: boolean; empty_reason?: string; graded?: number; overall?: S; featured?: S; tiers?: { td: (S & { tier: string })[]; props: (S & { tier: string })[] };
  by_market?: (S & { market: string; label: string })[]; by_side?: (S & { side: string })[]; weeks: WeekRow[]; drift?: string[]; method?: string[];
  last_week?: { season: number; week: number; featured_misses: { player_name: string; team: string; market: string; side: string; line: number | null; p: number; actual: number | null; tier: string }[] };
};

export const useLiveRecord = () => useQuery({ queryKey: ["live-record"], queryFn: () => api.get<LiveRecord>("/backtest/live"), staleTime: 5 * 60_000 });

const vs = (s?: S) => (s && s.n ? `${s.hits} of ${s.n} hit (${pct(s.rate, 0)}) · site gave ${pct(s.avg_chance, 0)}` : "none graded yet");

export function LiveRecordCard() {
  const q = useLiveRecord();
  const d = q.data;
  if (!d) return null;
  const pendingWeek = d.weeks.find((w) => w.pending > 0);
  return (
    <Card>
      <CardHeader icon={<Activity className="h-4 w-4 text-accent" />} title="Live report card"
        subtitle="Every pick the site showed, saved before kickoff and graded against the box score after the game. No hindsight: rows freeze when a game starts." />
      <CardBody className="space-y-4">
        {!d.available ? (
          <p className="text-sm text-muted">{d.empty_reason}{pendingWeek ? ` ${pendingWeek.picks.toLocaleString()} Week ${pendingWeek.week} picks are saved and waiting on results.` : ""}</p>
        ) : <>
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
            <Stat label="Picks graded" value={d.graded?.toLocaleString() ?? "0"} sub={`${d.weeks.filter((w) => w.graded).length} weeks`} />
            <Stat label="All picks" value={pct(d.overall?.rate, 0)} sub={`vs ${pct(d.overall?.avg_chance, 0)} expected`} />
            <Stat label="Featured (Top 3 + Strong)" value={pct(d.featured?.rate, 0)} sub={vs(d.featured)} />
            <Stat label="Drift flags" value={d.drift?.length ? String(d.drift.length) : "None"} sub={d.drift?.length ? d.drift[0] : "every tier within its expected range"} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            {(["td", "props"] as const).map((k) => (
              <div key={k}>
                <div className="mb-1 text-sm font-medium">{k === "td" ? "Anytime touchdown" : "Player props (leaning side)"}</div>
                <table className="w-full text-sm"><thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="pb-1 font-medium">Tier</th><th className="pb-1 text-right font-medium">Expected</th><th className="pb-1 text-right font-medium">Hit</th><th className="pb-1 text-right font-medium">Picks</th></tr></thead>
                  <tbody>{d.tiers?.[k].filter((t) => t.n).map((t) => (
                    <tr key={t.tier} className="border-t border-line/60"><td className="py-1.5">{t.tier}{t.drift && <span className="ml-1 text-xs text-warn">{t.drift}</span>}</td>
                      <td className="py-1.5 text-right text-muted">{pct(t.avg_chance, 0)}</td><td className="py-1.5 text-right font-semibold">{pct(t.rate, 0)}</td>
                      <td className="py-1.5 text-right text-muted">{t.n.toLocaleString()}</td></tr>))}</tbody></table>
              </div>))}
          </div>
          {!!d.by_market?.length && (
            <TableWrap>
              <table className="w-full"><thead><tr><Th>Market</Th><Th className="text-right">Expected</Th><Th className="text-right">Hit</Th><Th className="text-right">Picks</Th></tr></thead>
                <tbody>{d.by_market.map((m) => (
                  <tr key={m.market} className="border-b border-line/60"><Td>{m.label}</Td><Td className="text-right text-muted">{pct(m.avg_chance, 0)}</Td>
                    <Td className="text-right font-semibold">{pct(m.rate, 0)}</Td><Td className="text-right text-muted">{m.n.toLocaleString()}</Td></tr>))}</tbody></table>
            </TableWrap>)}
          {!!d.last_week?.featured_misses.length && (
            <div className="text-sm">
              <div className="font-medium">Featured picks that missed in Week {d.last_week.week}</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{d.last_week.featured_misses.map((x) => (
                <li key={`${x.player_name}-${x.market}`}>{x.player_name} ({x.team}): {x.market === "td" ? "anytime TD" : `${x.side} ${x.line} ${x.market.replace(/_/g, " ")}`} at {pct(x.p, 0)}, actual {x.actual == null ? "—" : num(x.actual, 0)}</li>))}</ul>
            </div>)}
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">{d.method?.map((m) => <li key={m}>{m}</li>)}</ul>
        </>}
      </CardBody>
    </Card>
  );
}
