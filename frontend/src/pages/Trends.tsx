import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { num, pct, POSITIONS } from "@/lib/format";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, PosBadge, Segmented, Stat, TableWrap, Td, TeamBadge, Th } from "@/components/ui";

type Bin = { lo: number; hi: number; n: number; scored: number; rate: number | null; ci: [number | null, number | null]; prior_n: number; prior_rate: number | null };
type Lift = { metric: string; label: string; bins: Bin[]; missing: number; spearman: number | null };
type Trends = {
  season: number; weeks: number[]; player_games: number; scorer_games: number; base_rate: number; touchdowns: number;
  by_position: Record<string, number>; origin: { yards: string; rush: number; pass: number; share: number | null }[]; lift: Lift[];
  pregame_rank_of_scorers: { model: string; scorers: number; tiers: { ranks: string; scorers: number; players: number; rate: number | null }[] } | null;
  repeat_scoring: Record<string, { n: number; rate: number }>;
  leaders: { player_id: string; player_name: string; position: string; team: string; games: number; tds: number; td_games: number; rz_opps: number; goal10_opps: number; xtd: number }[];
  defenses: { defense: string; position: string; tds: number; games: number; xtd: number }[];
  notes: string[]; empty_reason?: string;
};

type Tendency = { group: string; metric: string; label: string; in_model: boolean; r_half: number | null; r_next: number | null; n_half: number; n_next: number; verdict: string };
type SitCell = { n: number; rate: number | null; ci: [number | null, number | null] };
type Tendencies = { seasons: [number, number]; player_games: number; tendencies: Tendency[]; notes: string[]; empty_reason?: string;
  situations: { factor: string; label: string; rows: ({ bucket: string } & Record<"RB" | "WR" | "TE", SitCell>)[] }[] };

function TendencyCard() {
  const q = useQuery({ queryKey: ["tendencies"], queryFn: () => api.get<Tendencies>("/tendencies") });
  const d = q.data;
  const [group, setGroup] = React.useState("RBs");
  if (!d || d.empty_reason) return null;
  const groups = [...new Set(d.tendencies.map((t) => t.group))];
  const rows = d.tendencies.filter((t) => t.group === group).sort((a, b) => ((b.r_half ?? 0) + (b.r_next ?? 0)) - ((a.r_half ?? 0) + (a.r_next ?? 0)));
  const tone = (v: string) => (v === "Repeats strongly" ? "ok" : v === "Some signal" ? "neutral" : "warn") as "ok" | "neutral" | "warn";
  return (
    <>
      <Card>
        <CardHeader title={`Which tendencies are real? (${d.seasons[0]}–${d.seasons[1]})`}
          subtitle="A pattern only helps predict if it repeats. 1.0 = repeats perfectly, 0 = pure luck." />
        <div className="overflow-x-auto px-4 pb-2 sm:px-5">
          <Segmented size="sm" label="Group" value={group} onChange={setGroup} options={groups.map((g) => ({ value: g, label: g }))} />
        </div>
        <TableWrap>
          <table className="w-full"><thead><tr><Th>Tendency</Th><Th className="text-right" title="Odd weeks vs even weeks of the same season">Within a season</Th>
            <Th className="text-right" title="One season vs the next">Season to season</Th><Th>Verdict</Th><Th>Used by model</Th></tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.metric} className="border-b border-line/60"><Td>{t.label}</Td><Td className="text-right">{num(t.r_half, 2)}</Td><Td className="text-right">{num(t.r_next, 2)}</Td>
                <Td><Badge tone={tone(t.verdict)}>{t.verdict}</Badge></Td><Td className="text-muted">{t.in_model ? "Yes" : "—"}</Td></tr>))}</tbody></table>
        </TableWrap>
        <CardBody className="space-y-1 text-xs text-muted">
          <p><b className="text-fg">What this means:</b> a player's red-zone role, targets and snap share carry over strongly, so they drive the picks. Scoring more or fewer TDs than expected (finishing) and a defense's TDs allowed barely repeat, so the model treats them as mostly luck and only nudges for them.</p>
          {d.notes.map((n) => <p key={n}>{n}</p>)}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Game situations" subtitle={`How often players with a red-zone role scored, ${d.seasons[0]}–${d.seasons[1]} (${d.player_games.toLocaleString()} player-games)`} />
        <CardBody className="grid gap-5 md:grid-cols-2">
          {d.situations.map((s) => (
            <div key={s.factor}><div className="mb-1 text-sm font-medium">{s.label}</div>
              <table className="w-full text-sm"><thead><tr className="text-[11px] uppercase tracking-wide text-muted"><th className="text-left font-medium" />{(["RB", "WR", "TE"] as const).map((p) => <th key={p} className="text-right font-medium">{p}</th>)}</tr></thead>
                <tbody>{s.rows.map((r) => (
                  <tr key={r.bucket} className="border-t border-line/50"><td className="py-1 text-muted">{r.bucket}</td>
                    {(["RB", "WR", "TE"] as const).map((p) => <td key={p} className="py-1 text-right" title={`${r[p].n.toLocaleString()} player-games`}>{pct(r[p].rate, 0)}</td>)}</tr>))}</tbody></table>
            </div>
          ))}
        </CardBody>
      </Card>
    </>
  );
}

const binLabel = (b: Bin) => (b.hi >= 9 ? `${b.lo}+` : `${b.lo}–${b.hi}`);

export default function TrendsPage() {
  const { season } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const q = useQuery({ queryKey: ["trends", season], queryFn: () => api.get<Trends>("/scoring-trends", { season }) });
  const d = q.data;
  if (q.isError) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  if (!d) return <Card><LoadingBlock rows={6} className="p-5" /></Card>;
  if (d.empty_reason) return <Notice tone="info">{d.empty_reason}</Notice>;
  const top = d.pregame_rank_of_scorers;
  const generous = POSITIONS.map((pos) => ({
    pos, rows: d.defenses.filter((x) => x.position === pos).map((x) => ({ ...x, pg: x.tds / Math.max(x.games, 1) }))
      .sort((a, b) => b.pg - a.pg).slice(0, 5),
  }));
  return (
    <div className="space-y-5">
      <PageTitle kicker={`History and ${d.season} so far`} title="Trends" />
      <TendencyCard />
      <h2 className="pt-2 font-display text-lg font-semibold">{d.season} so far · Weeks {d.weeks[0]}–{d.weeks[d.weeks.length - 1]}</h2>
      <Card>
        <CardBody className="flex flex-wrap gap-8">
          <Stat label="Rush + rec TDs" value={d.touchdowns} />
          <Stat label="Player-games" value={d.player_games.toLocaleString()} sub={`${pct(d.base_rate, 1)} scored`} />
          {POSITIONS.map((p) => <Stat key={p} label={`${p} TDs`} value={d.by_position[p] ?? 0} />)}
          <Stat label="Scored last game → scored again" value={pct(d.repeat_scoring["1"]?.rate, 0)} sub={`vs ${pct(d.repeat_scoring["0"]?.rate, 0)} if not`} />
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Where touchdowns start" subtitle="Yards from the goal line at the snap of the scoring play" />
          <CardBody className="h-64">
            <ResponsiveContainer>
              <BarChart data={d.origin}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--line))" vertical={false} />
                <XAxis dataKey="yards" stroke="rgb(var(--muted))" fontSize={12} />
                <YAxis stroke="rgb(var(--muted))" fontSize={12} />
                <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))" }} />
                <Bar dataKey="rush" name="Rush" stackId="a" fill="rgb(var(--accent))" />
                <Bar dataKey="pass" name="Reception" stackId="a" fill="rgb(var(--info))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>
        {top && (
          <Card>
            <CardHeader title="Were the scorers visible beforehand?" subtitle={`Pregame rank by ${top.model} (walk-forward: each week ranked using only earlier games)`} />
            <TableWrap>
              <table className="w-full"><thead><tr><Th>Pregame rank</Th><Th className="text-right">Scorers</Th><Th className="text-right">Players</Th><Th className="text-right">Scored</Th></tr></thead>
                <tbody>{top.tiers.map((t) => <tr key={t.ranks}><Td>{t.ranks}</Td><Td className="text-right">{t.scorers}</Td><Td className="text-right text-muted">{t.players}</Td><Td className="text-right font-semibold">{pct(t.rate, 0)}</Td></tr>)}</tbody></table>
            </TableWrap>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader title="Which pregame metrics separated scorers" subtitle="TD rate by the value each player carried into the game. Ordered by strength of relationship this season; grey = same bins last season." />
        <CardBody className="grid gap-5 md:grid-cols-2">
          {d.lift.map((l) => (
            <div key={l.metric}>
              <div className="mb-1 flex items-baseline justify-between gap-2"><span className="text-sm font-medium">{l.label}</span><span className="text-xs text-muted">rank corr {num(l.spearman, 2)}</span></div>
              <table className="w-full text-sm"><tbody>{l.bins.map((b) => (
                <tr key={b.lo} className="border-b border-line/50">
                  <td className="w-20 py-1 text-muted">{binLabel(b)}</td>
                  <td className="py-1"><div className="h-2 rounded bg-accent/70" style={{ width: `${Math.min(100, (b.rate ?? 0) * 100)}%` }} /></td>
                  <td className="w-14 py-1 text-right font-medium">{b.n ? pct(b.rate, 0) : "—"}</td>
                  <td className="w-14 py-1 text-right text-xs text-muted">{b.prior_rate != null ? pct(b.prior_rate, 0) : "—"}</td>
                  <td className="w-16 py-1 text-right text-xs text-muted">n={b.n}</td>
                </tr>))}</tbody></table>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader title="Touchdown leaders" subtitle="Scoring chances and play-based xTD alongside actual TDs" />
          <TableWrap>
            <table className="w-full"><thead><tr><Th>Player</Th><Th className="text-right">G</Th><Th className="text-right">TDs</Th><Th className="text-right">TD games</Th><Th className="text-right">RZ opps</Th><Th className="text-right">Inside 10</Th><Th className="text-right">xTD</Th></tr></thead>
              <tbody>{d.leaders.map((r) => (
                <tr key={r.player_id + r.team}><Td><div className="flex items-center gap-2"><TeamBadge team={r.team} /><PosBadge pos={r.position} /><Link className="hover:text-accent" to={`/players/${r.player_id}${suffix}`}>{r.player_name}</Link></div></Td>
                  <Td className="text-right">{r.games}</Td><Td className="text-right font-semibold">{r.tds}</Td><Td className="text-right">{r.td_games}</Td><Td className="text-right">{r.rz_opps}</Td><Td className="text-right">{r.goal10_opps}</Td><Td className="text-right text-muted">{num(r.xtd, 1)}</Td></tr>))}</tbody></table>
          </TableWrap>
        </Card>
        <Card>
          <CardHeader title="Most generous defenses" subtitle="Rush + rec TDs allowed per game by position, this season" />
          <CardBody className="grid grid-cols-2 gap-4">
            {generous.map((g) => (
              <div key={g.pos}><div className="label mb-1">{g.pos}</div>
                <ul className="space-y-1 text-sm">{g.rows.map((r) => <li key={r.defense} className="flex justify-between"><Link className="hover:text-accent" to={`/defenses/${r.defense}${suffix}`}>{r.defense}</Link><span>{num(r.pg, 2)} <span className="text-xs text-muted">({r.tds} in {r.games})</span></span></li>)}</ul>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}
