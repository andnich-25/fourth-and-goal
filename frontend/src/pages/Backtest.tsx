import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, FlaskConical, XCircle } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, ErrorBar, Legend, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { useConfidence, type Tier } from "@/lib/confidence";
import { chicago, cn, num, pct } from "@/lib/format";
import type { CalBin, Gate, ProbMetrics, TopN, TopPolicy } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { TuningCard } from "@/components/TuningCard";
import { LiveRecordCard } from "@/components/LiveRecord";
import { Badge, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Segmented, Select, Stat, TableWrap, Td, Th } from "@/components/ui";
import { NoDataState, TierBadge } from "@/components/shared";

type Summary = {
  available: boolean; empty_reason?: string; run_id: string; created_at: string; test_weeks: [number, number][]; eligible_population: string;
  overall: Record<string, ProbMetrics>; by_season: Record<string, Record<string, ProbMetrics>>; by_position: Record<string, Record<string, ProbMetrics>>;
  topn: Record<string, Record<string, TopN> & { top3_policy: TopPolicy }>; gate: Gate; method: string[];
};
type WeekRow = { season: number; week: number; n: number; scorers: number; [k: string]: unknown };
type Pick = { model: string; season: number; week: number; player_id: string; player_name: string; team: string; position: string; opponent: string; score: number; participated: number; scored: number | null };

const LABEL: Record<string, string> = {
  "fg-structural-1": "Structural (team TD × share × matchup)", "fg-logit-1": "Logistic regression", "fg-gbm-1": "Gradient boosting",
  "baseline-position-rate": "Baseline: position rate", "baseline-shrunk-player-rate": "Baseline: shrunk player TD rate", "baseline-opportunity": "Baseline: opportunity volume (rank only)",
};

type OddsRecord = { weeks: number; picks: number; wins?: number; win_rate?: number | null; avg_implied?: number | null; units?: number; roi?: number | null;
  priced_legs?: number; note?: string; empty_reason?: string };

export function TierTable({ title, sub, tiers }: { title: string; sub: string; tiers: Tier[] }) {
  return (
    <div>
      <div className="text-sm font-medium">{title}</div><div className="mb-2 text-xs text-muted">{sub}</div>
      <table className="w-full text-sm"><thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted">
        <th className="pb-1 font-medium">Confidence</th><th className="pb-1 font-medium">Our chance</th><th className="pb-1 text-right font-medium">Hit</th><th className="pb-1 text-right font-medium">Picks</th></tr></thead>
        <tbody>{tiers.map((x) => (
          <tr key={x.tier} className="border-t border-line/60"><td className="py-1.5"><TierBadge tier={x} compact /></td>
            <td className="py-1.5 text-muted">{pct(x.lo, 0)}{x.hi >= 1 ? "+" : `–${pct(x.hi, 0)}`} <span className="text-xs">(avg {pct(x.avg_chance, 0)})</span></td>
            <td className="py-1.5 text-right font-semibold">{pct(x.rate, 0)}</td><td className="py-1.5 text-right text-muted">{x.n.toLocaleString()}</td></tr>))}</tbody></table>
    </div>
  );
}

function PlainSummary({ tp, weeks }: { tp?: { top3_policy: TopPolicy }; weeks: number }) {
  const conf = useConfidence();
  const rec = useQuery({ queryKey: ["odds-record"], queryFn: () => api.get<OddsRecord>("/odds/record") });
  const pol = tp?.top3_policy;
  const r = rec.data;
  return (
    <>
      <Card>
        <CardBody className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <Stat label="Weeks tested" value={weeks} sub="each predicted from earlier games only" />
          <Stat label="Top 3 picks that scored" value={pct(pol?.leg_hit_rate)} sub={pol ? `${pol.leg_hits.toLocaleString()} of ${pol.legs_graded.toLocaleString()}` : undefined} />
          <Stat label="All 3 scored" value={pct(pol?.all3_rate)} sub={pol ? `${pol.all3_hits} of ${pol.weeks_with_3_legs} weeks` : undefined} />
          <Stat label="Against the books" value={r && r.picks ? `${r.units! >= 0 ? "+" : ""}${num(r.units, 1)} units` : "Starting now"}
            sub={r && r.picks ? `${r.wins}/${r.picks} won (${pct(r.win_rate, 0)}) vs ${pct(r.avg_implied, 0)} implied` : "graded from the first weekly price pull"} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Does the confidence rating hold up?" subtitle="Every past pick, grouped by the chance we gave it. If the ratings are honest, the hit rate matches the chance." />
        <CardBody className="grid gap-6 lg:grid-cols-2">
          {conf.data?.td && <TierTable title="Anytime touchdown" sub={`${conf.data.td.weeks} weeks since ${conf.data.td.first_season}`} tiers={conf.data.td.tiers} />}
          {conf.data?.props && <TierTable title="Player props (side we favored)" sub={conf.data.props.note} tiers={conf.data.props.tiers} />}
        </CardBody>
      </Card>
    </>
  );
}

export default function BacktestPage() {
  const s = useQuery({ queryKey: ["bt-summary"], queryFn: () => api.get<Summary>("/backtest/summary") });
  const w = useQuery({ queryKey: ["bt-weeks"], queryFn: () => api.get<{ weeks: WeekRow[] }>("/backtest/weeks") });
  const cal = useQuery({ queryKey: ["bt-cal"], queryFn: () => api.get<{ models: Record<string, CalBin[]> }>("/backtest/calibration") });
  const d = s.data;
  const promoted = d?.gate?.promoted ?? null;
  const [model, setModel] = React.useState<string>("");
  React.useEffect(() => { if (d && !model) setModel(promoted ?? "fg-structural-1"); }, [d, model, promoted]);
  const picks = useQuery({ queryKey: ["bt-picks", model], enabled: !!model, queryFn: () => api.get<{ picks: Pick[] }>("/backtest/picks", { model }) });
  const [season, setSeason] = React.useState<string>("all");

  if (s.isError) return <Card><ErrorState error={s.error} onRetry={() => s.refetch()} /></Card>;
  if (s.isLoading) return <Card><LoadingBlock rows={8} className="p-5" /></Card>;
  if (!d?.available) return <><PageTitle title="Historical backtest" /><Card><NoDataState reason={d?.empty_reason} /></Card></>;

  const names = Object.keys(d.overall);
  const calData = (cal.data?.models[model] ?? []).map((b) => ({ x: b.mean_pred, y: b.observed, n: b.n, err: [b.observed - (b.ci[0] ?? b.observed), (b.ci[1] ?? b.observed) - b.observed], bin: `${b.lo.toFixed(1)}–${b.hi.toFixed(1)}` }));
  const weekly = (w.data?.weeks ?? []).filter((r) => season === "all" || String(r.season) === season).map((r) => ({
    label: `${String(r.season).slice(2)}·${r.week}`, hits: r[`${model}::top3_hits`] as number, base: r["baseline-shrunk-player-rate::top3_hits"] as number,
    ll: (r[model] as { log_loss: number })?.log_loss, llBase: (r["baseline-shrunk-player-rate"] as { log_loss: number })?.log_loss,
  }));
  const m = d.overall[model];
  const tp = d.topn[model];

  return (
    <div className="space-y-5">
      <PageTitle kicker={`${d.test_weeks.length} weeks the model never saw · ${d.test_weeks[0]?.[0]}–${d.test_weeks.at(-1)?.[0]}`} title="Track record" />
      <PlainSummary tp={d.topn[promoted ?? "fg-logit-1"]} weeks={d.test_weeks.length} />
      <LiveRecordCard />
      <Card>
          <CardHeader title="Top-3 hits by week" subtitle="Selected model vs shrunk-rate baseline (picks who played, max 3)"
            action={<Segmented size="sm" label="Season" value={season} onChange={setSeason} options={[{ value: "all", label: "All" }, ...[...new Set(d.test_weeks.map((x) => String(x[0])))].map((s) => ({ value: s, label: s }))]} />} />
          <CardBody>
            <div className="h-72" role="img" aria-label="Weekly top-3 hits for the selected model and the baseline">
              <ResponsiveContainer>
                <ComposedChart data={weekly} margin={{ left: -24, right: 8, top: 8 }}>
                  <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: "rgb(var(--muted))", fontSize: 10 }} interval={0} angle={-45} textAnchor="end" height={40} />
                  <YAxis domain={[0, 3]} allowDecimals={false} tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "rgb(var(--raised))" }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="hits" name={LABEL[model] ?? model} fill="rgb(var(--accent))" radius={[3, 3, 0, 0]} />
                  <Line dataKey="base" name="Baseline" stroke="rgb(var(--info))" strokeWidth={2} dot={{ r: 2 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>
      <Card>
        <CardHeader title="Top 3 shortlist picks, week by week" subtitle="Evidence rules + one leg per game, pregame pool only. Frozen in the run; never edited." />
        {picks.isLoading && <LoadingBlock className="p-4" />}
        <TableWrap className="max-h-[440px]">
          <table className="w-full"><thead className="sticky top-0 bg-surface"><tr><Th>Season</Th><Th>Week</Th><Th>Player</Th><Th>Pos</Th><Th>Matchup</Th><Th className="text-right">Estimate</Th><Th>Result</Th></tr></thead>
            <tbody>{picks.data?.picks.slice().reverse().map((p) => (
              <tr key={`${p.season}-${p.week}-${p.player_id}`}><Td>{p.season}</Td><Td>{p.week}</Td><Td>{p.player_name}</Td><Td>{p.position}</Td><Td className="text-muted">{p.team} vs {p.opponent}</Td>
                <Td className="text-right">{model === "baseline-opportunity" ? `${num(p.score)} opp/g` : pct(p.score)}</Td>
                <Td>{!p.participated ? <Badge>void</Badge> : p.scored ? <Badge tone="accent">TD</Badge> : <Badge tone="neutral">No TD</Badge>}</Td></tr>))}
            </tbody></table>
        </TableWrap>
      </Card>

      <details className="card group">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium sm:px-5">
          Technical details: model comparison, validation checks, calibration <ChevronDown className="h-4 w-4 text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-5 border-t border-line p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted">Model</span>
            <Select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
              {[...names, "baseline-opportunity"].map((n) => <option key={n} value={n}>{LABEL[n] ?? n}{n === promoted ? " (promoted)" : ""}</option>)}
            </Select>
            <span className="text-xs text-muted">Run {d.run_id} · {chicago(d.created_at)}</span>
          </div>
      <Card>
        <CardBody className="grid grid-cols-2 gap-5 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Test weeks" value={d.test_weeks.length} sub={`${d.test_weeks[0]?.join(" W")} → ${d.test_weeks.at(-1)?.join(" W")}`} />
          <Stat label="Player-games" value={(m?.n ?? d.overall[names[0]].n).toLocaleString()} sub={`TD base rate ${pct(d.overall[names[0]].base_rate, 1)}`} />
          <Stat label="Brier" value={num(m?.brier, 4)} sub={m ? `vs ${num(d.overall["baseline-shrunk-player-rate"].brier, 4)} baseline` : "rank-only model"} />
          <Stat label="Log loss" value={num(m?.log_loss, 4)} sub={m ? `vs ${num(d.overall["baseline-shrunk-player-rate"].log_loss, 4)} baseline` : "—"} />
          <Stat label="Top-3 hit rate" value={pct(tp?.top3.hit_rate)} sub={`${tp?.top3.hits}/${tp?.top3.graded} · CI ${pct(tp?.top3.ci[0])}–${pct(tp?.top3.ci[1])}`} />
          <Stat label="All 3 legs scored" value={pct(tp?.top3_policy.all3_rate)} sub={`${tp?.top3_policy.all3_hits}/${tp?.top3_policy.weeks_with_3_legs} three-leg weeks · rules applied`} />
        </CardBody>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeader title="Model comparison on unseen weeks" subtitle={d.eligible_population} />
          <TableWrap>
            <table className="w-full"><thead><tr><Th>Model</Th><Th className="text-right">Brier ↓</Th><Th className="text-right">Log loss ↓</Th><Th className="text-right">AUC ↑</Th><Th className="text-right">ECE ↓</Th><Th className="text-right">Top-1</Th><Th className="text-right">Top-3</Th><Th className="text-right">Top-5</Th><Th className="text-right">Top-10</Th></tr></thead>
              <tbody>{[...names, "baseline-opportunity"].map((n) => {
                const o = d.overall[n]; const t = d.topn[n];
                return (
                  <tr key={n} className={cn(n === model && "bg-raised/40")}>
                    <Td className="whitespace-normal"><span className="font-medium">{LABEL[n] ?? n}</span> {n === promoted && <Badge tone="accent">promoted</Badge>}</Td>
                    <Td className="text-right">{num(o?.brier, 4)}</Td><Td className="text-right">{num(o?.log_loss, 4)}</Td><Td className="text-right">{num(o?.auc, 3)}</Td><Td className="text-right">{num(o?.ece, 4)}</Td>
                    {(["top1", "top3", "top5", "top10"] as const).map((k) => <Td key={k} className="text-right" title={`${t[k].hits}/${t[k].graded}, 95% CI ${pct(t[k].ci[0])}–${pct(t[k].ci[1])}${t[k].voids ? `, ${t[k].voids} void` : ""}`}>{pct(t[k].hit_rate)}</Td>)}
                  </tr>);
              })}</tbody></table>
          </TableWrap>
          <p className="border-t border-line px-5 py-3 text-xs text-muted">Top-N hit rate = picks who scored ÷ picks who played. Hover a rate for counts and Wilson 95% intervals.</p>
        </Card>

        <Card>
          <CardHeader title="Promotion gate" subtitle={promoted ? `Promoted: ${LABEL[promoted]}` : "No model promoted — probabilities hidden across the app"} icon={<FlaskConical className="h-4 w-4 text-accent" />} />
          <CardBody className="space-y-4">
            {Object.entries(d.gate.candidates).map(([name, c]) => (
              <details key={name} open={name === (promoted ?? "fg-structural-1")}>
                <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  {c.passed ? <CheckCircle2 className="h-4 w-4 text-accent" /> : <XCircle className="h-4 w-4 text-danger" />}{LABEL[name]}
                  <span className="text-xs text-muted">{c.passed ? "passed" : "failed"}</span>
                </summary>
                <ul className="mt-2 space-y-1 pl-6 text-xs">
                  {c.checks.map((x) => (
                    <li key={x.check} className="flex gap-2">
                      <span className={x.pass ? "text-accent" : "text-danger"}>{x.pass ? "✓" : "✗"}</span>
                      <span className="text-muted">{x.check}: <span className="num text-fg">{Array.isArray(x.value) ? x.value.map((v) => typeof v === "number" ? v.toFixed(4) : String(v)).join(" vs ") : typeof x.value === "number" ? (Number.isInteger(x.value) ? x.value : x.value.toFixed(4)) : String(x.value)}</span></span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
            <p className="text-xs text-muted">When several candidates pass, the simplest one within 0.001 log loss of the best is promoted.</p>
          </CardBody>
        </Card>
      </div>

        <Card>
          <CardHeader title="Reliability (calibration)" subtitle="Mean predicted vs observed TD rate per probability bin, with 95% intervals" />
          <CardBody>
            {m ? (
              <>
                <div className="h-72" role="img" aria-label="Calibration plot. The table below lists each bin.">
                  <ResponsiveContainer>
                    <ComposedChart data={calData} margin={{ left: -10, right: 12, top: 8 }}>
                      <CartesianGrid stroke="rgb(var(--line))" />
                      <XAxis type="number" dataKey="x" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} name="Predicted" />
                      <YAxis type="number" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} name="Observed" />
                      <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 8, fontSize: 12 }} formatter={(v: number) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : v)} />
                      <Line data={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} dataKey="y" stroke="rgb(var(--muted))" strokeDasharray="4 4" dot={false} isAnimationActive={false} name="Perfect" />
                      <Scatter dataKey="y" fill="rgb(var(--accent))" name="Observed">
                        <ErrorBar dataKey="err" width={4} strokeWidth={1.5} stroke="rgb(var(--accent))" direction="y" />
                      </Scatter>
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <TableWrap className="mt-3">
                  <table className="w-full"><thead><tr><Th>Bin</Th><Th className="text-right">n</Th><Th className="text-right">Predicted</Th><Th className="text-right">Observed</Th></tr></thead>
                    <tbody>{calData.map((b) => <tr key={b.bin}><Td>{b.bin}</Td><Td className="text-right">{b.n}</Td><Td className="text-right">{pct(b.x, 1)}</Td><Td className="text-right">{pct(b.y, 1)}</Td></tr>)}</tbody></table>
                </TableWrap>
              </>
            ) : <p className="text-sm text-muted">Rank-only baseline: no probabilities to calibrate.</p>}
          </CardBody>
        </Card>

      <Card>
        <CardHeader title="By position and season" />
        <TableWrap>
          <table className="w-full"><thead><tr><Th>Slice</Th><Th className="text-right">n</Th><Th className="text-right">TD rate</Th><Th className="text-right">Brier</Th><Th className="text-right">Log loss</Th><Th className="text-right">Baseline log loss</Th><Th className="text-right">AUC</Th></tr></thead>
            <tbody>
              {m && Object.entries(d.by_position[model] ?? {}).map(([pos, x]) => <tr key={pos}><Td>{pos}</Td><Td className="text-right">{x.n}</Td><Td className="text-right">{pct(x.base_rate, 1)}</Td><Td className="text-right">{num(x.brier, 4)}</Td><Td className="text-right">{num(x.log_loss, 4)}</Td><Td className="text-right text-muted">{num(d.by_position["baseline-shrunk-player-rate"][pos]?.log_loss, 4)}</Td><Td className="text-right">{num(x.auc, 3)}</Td></tr>)}
              {m && Object.entries(d.by_season[model] ?? {}).map(([s2, x]) => <tr key={s2} className="bg-raised/30"><Td>Season {s2}</Td><Td className="text-right">{x.n}</Td><Td className="text-right">{pct(x.base_rate, 1)}</Td><Td className="text-right">{num(x.brier, 4)}</Td><Td className="text-right">{num(x.log_loss, 4)}</Td><Td className="text-right text-muted">{num(d.by_season["baseline-shrunk-player-rate"][s2]?.log_loss, 4)}</Td><Td className="text-right">{num(x.auc, 3)}</Td></tr>)}
            </tbody></table>
        </TableWrap>
      </Card>

      <TuningCard />

      <Card>
        <CardHeader title="Method and limits" />
        <CardBody><ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">{d.method.map((x) => <li key={x}>{x}</li>)}</ul></CardBody>
      </Card>

        </div>
      </details>
    </div>
  );
}
