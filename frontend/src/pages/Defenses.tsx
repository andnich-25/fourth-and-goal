import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ShieldOff } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { cn, kickoff, num, pct, POSITIONS } from "@/lib/format";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, Segmented, Select, TeamBadge } from "@/components/ui";
import { NoDataState } from "@/components/shared";

type PosAllowed = { tds: number; rush_tds: number; rec_tds: number; xtd: number; tds_pg: number; xtd_pg: number; rz_carries: number; rz_targets: number; goal5_carries: number; goal5_targets: number; ez_target_proxy: number };
export type DefenseRow = {
  defense: string; games: number; weeks: number[]; available: boolean; positions: Record<string, PosAllowed>;
  points_allowed_pg: number | null; offensive_tds_allowed_pg: number; xtd_allowed_pg: number; rz_trips_allowed: number | null;
  rz_td_drives_allowed: number | null; rz_td_rate_allowed: number | null; plays_faced_pg: number | null; drives_faced_pg: number | null;
  upcoming?: { opponent: string; home: boolean; gameday: string; gametime: string; opponent_implied_total: number | null } | null;
};
type DefResp = { season: number; week: number; window: number | null; teams: DefenseRow[]; league: Record<string, { tds_pg: number; xtd_pg: number }> & { rz_td_rate: number | null }; coverage: string; method: string; empty_reason?: string };

type SortKey = string;

export default function DefensesPage() {
  const { season, week } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const [window, setWindow] = React.useState<number>(0);
  const [metric, setMetric] = React.useState<"tds_pg" | "xtd_pg">("tds_pg");
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({ key: "RB", desc: true });
  const [cmp, setCmp] = React.useState<[string, string]>(["", ""]);
  const q = useQuery({ queryKey: ["defenses", season, week, window], queryFn: () => api.get<DefResp>("/defenses", { season, week, window: window || undefined }) });
  const d = q.data;
  const value = (r: DefenseRow, k: SortKey): number => {
    if (POSITIONS.includes(k as never)) return r.positions[k]?.[metric] ?? -1;
    return (r as unknown as Record<string, number | null>)[k] ?? -1;
  };
  const rows = React.useMemo(() => (d?.teams ?? []).filter((r) => r.available).slice().sort((a, b) => (value(a, sort.key) - value(b, sort.key)) * (sort.desc ? -1 : 1)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d, sort, metric]);
  React.useEffect(() => { if (rows.length >= 2 && !cmp[0]) setCmp([rows[0].defense, rows[1].defense]); }, [rows, cmp]);

  const head = (k: SortKey, label: React.ReactNode, title?: string) => (
    <th scope="col" aria-sort={sort.key === k ? (sort.desc ? "descending" : "ascending") : "none"} className="whitespace-nowrap border-b border-line px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-muted">
      <button title={title} className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setSort({ key: k, desc: sort.key === k ? !sort.desc : true })}>
        {label}{sort.key === k && (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  );

  const compareData = POSITIONS.map((p) => {
    const a = d?.teams.find((t) => t.defense === cmp[0]);
    const b = d?.teams.find((t) => t.defense === cmp[1]);
    return { pos: p, [cmp[0] || "A"]: a?.positions[p]?.[metric] ?? 0, [cmp[1] || "B"]: b?.positions[p]?.[metric] ?? 0, League: d?.league[p]?.[metric] ?? 0 };
  });

  return (
    <div className="space-y-5">
      <PageTitle kicker={`Completed games before ${season} Week ${week}`} title="Defense matchup explorer">
        <Segmented label="Sample window" value={window} onChange={setWindow} options={[{ value: 0, label: "Season" }, { value: 6, label: "Last 6" }, { value: 3, label: "Last 3" }]} />
        <Segmented label="Metric" value={metric} onChange={setMetric} options={[{ value: "tds_pg", label: "TDs/g" }, { value: "xtd_pg", label: "xTD/g" }]} />
      </PageTitle>

      {q.isError && <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>}
      {q.isLoading && <Card><LoadingBlock rows={12} className="p-4" /></Card>}
      {d && d.teams.length === 0 && <Card><NoDataState reason={d.empty_reason} /></Card>}

      {d && d.teams.length > 0 && (
        <>
          <Card className="overflow-hidden">
            <CardHeader title={`All ${rows.length} defenses`} subtitle={`${metric === "tds_pg" ? "Rushing + receiving TDs" : "Play-based xTD"} allowed per game to each offensive position. ▲ marks above league average; shading scales with the gap.`} />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="border-b border-line px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">Defense</th>
                    {head("games", "GP")}
                    {POSITIONS.map((p) => head(p, p))}
                    {head("offensive_tds_allowed_pg", "Off TD/g", "All offensive TDs allowed per game")}
                    {head("rz_td_rate_allowed", "RZ TD%", "Opponent drives reaching the 20 that ended in a touchdown")}
                    {head("plays_faced_pg", "Plays/g", "Opponent offensive plays per game (pace faced)")}
                    <th scope="col" className="border-b border-line px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">Week {week}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.defense} className="hover:bg-raised/40">
                      <td className="border-b border-line/60 px-3 py-1.5"><Link to={`/defenses/${r.defense}${suffix}`} className="inline-flex items-center gap-2 font-medium hover:text-accent"><TeamBadge team={r.defense} /></Link></td>
                      <td className="num border-b border-line/60 px-3 py-1.5 text-right text-muted">{r.games}</td>
                      {POSITIONS.map((p) => {
                        const v = r.positions[p]?.[metric] ?? 0;
                        const lg = d.league[p]?.[metric] || 0.0001;
                        const ratio = v / lg;
                        const above = ratio > 1.1;
                        return (
                          <td key={p} className="num border-b border-line/60 px-1.5 py-1.5 text-right">
                            <span className={cn("inline-block min-w-[56px] rounded px-2 py-0.5", above ? "text-fg" : "text-muted")}
                              style={{ backgroundColor: above ? `rgb(var(--warn) / ${Math.min(0.45, (ratio - 1) * 0.35)})` : ratio < 0.9 ? `rgb(var(--info) / ${Math.min(0.25, (1 - ratio) * 0.3)})` : undefined }}
                              title={`${p}: ${num(v, 2)} per game vs league ${num(lg, 2)} (${r.positions[p]?.rush_tds ?? 0} rush / ${r.positions[p]?.rec_tds ?? 0} rec TDs)`}>
                              {above && <span aria-label="above league average">▲ </span>}{num(v, 2)}
                            </span>
                          </td>
                        );
                      })}
                      <td className="num border-b border-line/60 px-3 py-1.5 text-right">{num(r.offensive_tds_allowed_pg, 2)}</td>
                      <td className="num border-b border-line/60 px-3 py-1.5 text-right">{r.rz_td_rate_allowed != null ? `${pct(r.rz_td_rate_allowed)}` : "—"}<span className="text-muted"> {r.rz_trips_allowed != null ? `(${r.rz_td_drives_allowed}/${r.rz_trips_allowed})` : ""}</span></td>
                      <td className="num border-b border-line/60 px-3 py-1.5 text-right">{num(r.plays_faced_pg, 1)}</td>
                      <td className="border-b border-line/60 px-3 py-1.5 text-xs text-muted">{r.upcoming ? <>{r.upcoming.home ? "vs" : "@"} <span className="text-fg">{r.upcoming.opponent}</span> · {kickoff(r.upcoming.gameday, r.upcoming.gametime)}</> : "Bye / no game"}</td>
                    </tr>
                  ))}
                  <tr className="bg-raised/40 font-medium">
                    <td className="px-3 py-2">League</td><td />
                    {POSITIONS.map((p) => <td key={p} className="num px-3 py-2 text-right">{num(d.league[p]?.[metric], 2)}</td>)}
                    <td /><td className="num px-3 py-2 text-right">{pct(d.league.rz_td_rate)}</td><td /><td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardHeader title="Compare two defenses" action={
                <div className="flex gap-2">
                  {[0, 1].map((i) => (
                    <Select key={i} aria-label={`Defense ${i + 1}`} value={cmp[i]} onChange={(e) => setCmp(i === 0 ? [e.target.value, cmp[1]] : [cmp[0], e.target.value])} className="h-8 text-xs">
                      {rows.map((r) => <option key={r.defense} value={r.defense}>{r.defense}</option>)}
                    </Select>
                  ))}
                </div>} />
              <CardBody>
                <div className="h-64" role="img" aria-label={`Bar chart comparing ${cmp[0]} and ${cmp[1]} ${metric === "tds_pg" ? "TDs" : "xTD"} allowed per game by position`}>
                  <ResponsiveContainer>
                    <BarChart data={compareData} margin={{ left: -16, right: 8, top: 8 }}>
                      <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                      <XAxis dataKey="pos" tick={{ fill: "rgb(var(--muted))", fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: "rgb(var(--muted))", fontSize: 12 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 8, fontSize: 12 }} formatter={(v: number) => v.toFixed(2)} cursor={{ fill: "rgb(var(--raised))" }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey={cmp[0] || "A"} fill="rgb(var(--accent))" radius={[4, 4, 0, 0]} />
                      <Bar dataKey={cmp[1] || "B"} fill="rgb(var(--info))" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="League" fill="rgb(var(--muted) / 0.5)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardBody>
            </Card>
            <div className="space-y-4">
              <Notice tone="info" title="Method">{d.method}</Notice>
              <Notice tone="warn" title="Coverage tracking not connected"><ShieldOff className="mr-1 inline h-3.5 w-3.5" />{d.coverage} Man/zone shares are not shown rather than invented.</Notice>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
