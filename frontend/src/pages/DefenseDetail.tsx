import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { kickoff, num, pct, POSITIONS } from "@/lib/format";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, PosBadge, Segmented, Stat, TableWrap, Td, TeamBadge, Th } from "@/components/ui";
import type { DefenseRow } from "./Defenses";

type Detail = {
  season: number; week: number; team: string; full: DefenseRow; last6: DefenseRow; last3: DefenseRow;
  weekly: { week: number; offense: string; position: string; touchdowns: number; xtd: number; opportunities: number; rz_carries: number; rz_targets: number; goal5_carries: number; goal5_targets: number; ez_target_proxy: number }[];
  touchdowns_allowed: { week: number; offense: string; player_id: string; player_name: string; position: string; event_type: string; yards_to_goal: number; air_yards: number | null; description: string }[];
  upcoming: { opponent: string; home: boolean; gameday: string; gametime: string; opponent_implied_total: number | null } | null;
  venom_notes: { stat: string; value: number; sample_games: number; source: string }[];
};
const COLORS: Record<string, string> = { QB: "rgb(var(--muted))", RB: "rgb(var(--accent))", WR: "rgb(var(--info))", TE: "rgb(var(--warn))" };

export default function DefenseDetail() {
  const { team = "" } = useParams();
  const { season, week } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const [win, setWin] = React.useState<"full" | "last6" | "last3">("full");
  const q = useQuery({ queryKey: ["defense", team, season, week], queryFn: () => api.get<Detail>(`/defenses/${team}`, { season, week }) });
  const d = q.data;
  const s = d?.[win];
  const chart = React.useMemo(() => {
    if (!d) return [];
    const by: Record<number, Record<string, number | string>> = {};
    d.weekly.forEach((w) => {
      by[w.week] ??= { week: `W${w.week}`, opp: w.offense };
      by[w.week][w.position] = ((by[w.week][w.position] as number) || 0) + w.touchdowns;
    });
    return Object.values(by);
  }, [d]);
  return (
    <div className="space-y-5">
      <Link to={`/defenses${suffix}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /> All defenses</Link>
      {q.isError && <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>}
      {q.isLoading && <Card><LoadingBlock rows={8} className="p-4" /></Card>}
      {d && s && (
        <>
          <PageTitle kicker={`Defense · before ${season} Week ${week}`} title={`${d.team} defense`}>
            <Segmented label="Window" value={win} onChange={setWin} options={[{ value: "full", label: "Season" }, { value: "last6", label: "Last 6" }, { value: "last3", label: "Last 3" }]} />
          </PageTitle>
          <div className="flex items-center gap-3"><TeamBadge team={d.team} size="lg" />
            <div className="text-sm text-muted">{d.upcoming ? <>Week {week}: {d.upcoming.home ? "hosts" : "at"} <span className="text-fg">{d.upcoming.opponent}</span> · {kickoff(d.upcoming.gameday, d.upcoming.gametime)} · opponent implied {num(d.upcoming.opponent_implied_total)} pts</> : `No Week ${week} game`}</div>
          </div>
          <Card><CardBody className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Games" value={s.games} sub={`Weeks ${s.weeks.join(", ")}`} />
            <Stat label="Points allowed/g" value={num(s.points_allowed_pg)} />
            <Stat label="Off. TDs allowed/g" value={num(s.offensive_tds_allowed_pg, 2)} />
            <Stat label="xTD allowed/g" value={num(s.xtd_allowed_pg, 2)} />
            <Stat label="RZ TD rate" value={pct(s.rz_td_rate_allowed)} sub={`${s.rz_td_drives_allowed ?? 0} TD drives / ${s.rz_trips_allowed ?? 0} trips`} hint="Opponent drives reaching the 20 that ended in a TD" />
            <Stat label="Plays faced/g" value={num(s.plays_faced_pg)} />
          </CardBody></Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Allowed by offensive position" subtitle="Where touchdowns happened, not which defenders were assigned" />
              <TableWrap>
                <table className="w-full"><thead><tr><Th>Pos</Th><Th className="text-right">TDs</Th><Th className="text-right">Rush/Rec</Th><Th className="text-right">TD/g</Th><Th className="text-right">xTD/g</Th><Th className="text-right">≤5 car</Th><Th className="text-right">RZ car</Th><Th className="text-right">≤5 tgt</Th><Th className="text-right">RZ tgt</Th><Th className="text-right" title="End-zone target proxy">EZ proxy</Th></tr></thead>
                  <tbody>{POSITIONS.map((p) => { const r = s.positions[p]; return (
                    <tr key={p}><Td><PosBadge pos={p} /></Td><Td className="text-right font-medium">{r.tds}</Td><Td className="text-right text-muted">{r.rush_tds}/{r.rec_tds}</Td><Td className="text-right">{num(r.tds_pg, 2)}</Td><Td className="text-right">{num(r.xtd_pg, 2)}</Td><Td className="text-right">{r.goal5_carries}</Td><Td className="text-right">{r.rz_carries}</Td><Td className="text-right">{r.goal5_targets}</Td><Td className="text-right">{r.rz_targets}</Td><Td className="text-right">{r.ez_target_proxy}</Td></tr>); })}
                  </tbody></table>
              </TableWrap>
            </Card>
            <Card>
              <CardHeader title="TDs allowed by week" />
              <CardBody>
                <div className="h-60" role="img" aria-label="Stacked bars of touchdowns allowed each week by position">
                  <ResponsiveContainer>
                    <BarChart data={chart} margin={{ left: -20, right: 8, top: 8 }}>
                      <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                      <XAxis dataKey="week" tick={{ fill: "rgb(var(--muted))", fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis allowDecimals={false} tick={{ fill: "rgb(var(--muted))", fontSize: 12 }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "rgb(var(--raised))" }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {POSITIONS.map((p) => <Bar key={p} dataKey={p} stackId="a" fill={COLORS[p]} />)}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Every touchdown allowed" subtitle={`${d.touchdowns_allowed.length} rushing/receiving TDs before Week ${week}`} />
            <TableWrap className="max-h-[420px]">
              <table className="w-full"><thead className="sticky top-0 bg-surface"><tr><Th>Wk</Th><Th>Offense</Th><Th>Player</Th><Th>Pos</Th><Th>Type</Th><Th className="text-right">Yds to goal</Th><Th>Play</Th></tr></thead>
                <tbody>{d.touchdowns_allowed.map((t, i) => (
                  <tr key={i}><Td>{t.week}</Td><Td>{t.offense}</Td><Td><Link className="hover:text-accent" to={`/players/${t.player_id}${suffix}`}>{t.player_name}</Link></Td><Td><PosBadge pos={t.position} /></Td><Td className="text-muted">{t.event_type === "pass" ? "Reception" : "Rush"}</Td><Td className="text-right">{t.yards_to_goal}</Td><Td className="max-w-[420px] truncate whitespace-normal text-xs text-muted">{t.description}</Td></tr>))}
                </tbody></table>
            </TableWrap>
          </Card>

          {d.venom_notes.length > 0 && (
            <Card>
              <CardHeader title={<span className="flex items-center gap-2">Venom screenshot notes <Badge tone="neutral">Week {week} only</Badge></span>} subtitle="User-supplied observations; compare with the computed numbers above" />
              <CardBody><ul className="space-y-1 text-sm">{d.venom_notes.map((n) => <li key={n.stat}><span className="font-medium">{n.value}</span> {n.stat} <span className="text-muted">({n.sample_games} games · {n.source})</span></li>)}</ul></CardBody>
            </Card>
          )}
          <Notice tone="warn" title="Coverage tracking not connected">Man/zone and Cover 1–4 rates require a charting source that is not imported, so none are shown.</Notice>
        </>
      )}
    </div>
  );
}
