import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Clock, Crosshair, ShieldAlert, Target, TrendingUp, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { chicago, cn, kickoff, num, pct } from "@/lib/format";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import type { ProbMetrics, Top3Response, TopN, TopPolicy } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { Badge, Button, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, PosBadge, Skeleton, Stat, TeamBadge } from "@/components/ui";
import { ConfidenceBadge, Estimate, Flags, ModelBadge, NoDataState, ReasonList } from "@/components/shared";

type Overview = {
  season: number; week: number; ready: boolean; data_loaded: boolean; analytics_through_week: number | null;
  sources_ok: number; sources_total: number; required_missing: string[]; last_import: string | null; latest_completed_gameday: string | null;
  games: { game_id: string; away: string; home: string; gameday: string; gametime: string; total: number | null; spread: number | null;
    home_implied: number | null; away_implied: number | null; away_score: number | null; home_score: number | null }[];
  top3: Top3Response;
  opportunity_leaders: { player_id: string; player_name: string; team: string; opponent: string; position: string; rank: number;
    rz_carries_pg: number; rz_targets_pg: number; goal5_carries_pg: number }[];
  defense_vulnerabilities: { defense: string; position: string; tds_pg: number; games: number; league_tds_pg: number; offense: string }[];
  model_performance: { model: string; promoted: string | null; overall: ProbMetrics; baseline: ProbMetrics; top3: TopN; top3_policy: TopPolicy;
    recent_weeks: { season: number; week: number; hits: number; graded: number }[] } | null;
  error: string | null;
};

export default function OverviewPage() {
  const { season, week } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const q = useQuery({ queryKey: ["overview", season, week], queryFn: () => api.get<Overview>("/overview", { season, week }) });
  if (q.isError) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const d = q.data;
  const completed = d?.games.length ? d.games.every((g) => g.home_score != null) : false;
  return (
    <div className="space-y-5">
      <PageTitle
        kicker={d ? `Analytics through Week ${d.analytics_through_week ?? week - 1}` : "Loading"}
        title={`Week ${week} · ${season}`}
      >
        {d && (
          <>
            <Badge tone={d.required_missing.length ? "warn" : "ok"}>
              {d.required_missing.length ? <XCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
              Sources verified {d.sources_ok}/{d.sources_total}
            </Badge>
            <ModelBadge version={d.top3.model_version} calibrated={d.top3.calibrated} />
          </>
        )}
      </PageTitle>

      {d && !d.data_loaded && <Card><NoDataState /></Card>}
      {d?.error && <Notice tone="danger" title="Last pipeline run stopped">{d.error}</Notice>}
      {completed && <Notice tone="info">This week is complete. Candidates were generated using only data before Week {week}; outcomes are shown for review.</Notice>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Top3Card t={d?.top3} loading={q.isLoading} suffix={suffix} />
        <div className="space-y-5">
          <PerformanceCard p={d?.model_performance ?? null} loading={q.isLoading} suffix={suffix} />
          <Card>
            <CardHeader title="Data sync" icon={<Clock className="h-4 w-4 text-muted" />} />
            <CardBody className="grid grid-cols-2 gap-4">
              <Stat label="Last import" value={<span className="text-base">{chicago(d?.last_import)}</span>} />
              <Stat label="Latest game in data" value={<span className="text-base">{d?.latest_completed_gameday ?? "—"}</span>} />
            </CardBody>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader title="Matchups" subtitle="Market spread/total from the nflverse schedule; implied team points = (total ± spread) / 2" />
        <div className="flex gap-3 overflow-x-auto p-4 sm:p-5">
          {q.isLoading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 w-44 shrink-0" />)}
          {d?.games.map((g) => (
            <div key={g.game_id} className="w-44 shrink-0 rounded-lg border border-line bg-bg/40 p-3">
              <div className="mb-2 text-[11px] text-muted">{kickoff(g.gameday, g.gametime)}</div>
              {[{ t: g.away, imp: g.away_implied, s: g.away_score }, { t: g.home, imp: g.home_implied, s: g.home_score }].map((x, i) => (
                <div key={x.t} className="flex items-center justify-between py-0.5">
                  <span className="flex items-center gap-2"><TeamBadge team={x.t} />{i === 1 && <span className="text-[10px] text-muted">home</span>}</span>
                  <span className="num text-sm font-medium">{x.s != null ? x.s : num(x.imp, 1)}</span>
                </div>
              ))}
              <div className="mt-1.5 text-[11px] text-muted">{g.total != null ? `O/U ${g.total}` : "No line"}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Scoring-area volume leaders" icon={<Crosshair className="h-4 w-4 text-accent" />} subtitle="Red-zone carries + targets per game, prior games only" />
          <CardBody className="p-0 sm:p-0">
            {q.isLoading ? <LoadingBlock className="p-4" /> : (
              <ul className="divide-y divide-line">
                {d?.opportunity_leaders.map((o) => (
                  <li key={o.player_id}>
                    <Link to={`/players/${o.player_id}${suffix}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised/50 sm:px-5">
                      <TeamBadge team={o.team} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{o.player_name} <span className="text-muted">vs {o.opponent}</span></div>
                        <div className="text-xs text-muted">{num(o.rz_carries_pg)} RZ carries · {num(o.rz_targets_pg)} RZ targets · {num(o.goal5_carries_pg)} inside-5 carries /g</div>
                      </div>
                      <PosBadge pos={o.position} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Defense vulnerabilities this week" icon={<ShieldAlert className="h-4 w-4 text-warn" />} subtitle="Largest excess of position TDs allowed per game over league average, this week's opponents (≥3 games)" />
          <CardBody className="p-0 sm:p-0">
            {q.isLoading ? <LoadingBlock className="p-4" /> : (
              <ul className="divide-y divide-line">
                {d?.defense_vulnerabilities.map((v) => (
                  <li key={v.defense + v.position}>
                    <Link to={`/defenses/${v.defense}${suffix}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised/50 sm:px-5">
                      <TeamBadge team={v.defense} />
                      <div className="min-w-0 flex-1 text-sm">
                        <span className="font-medium">{num(v.tds_pg, 2)}</span> {v.position} TDs allowed per game
                        <div className="text-xs text-muted">League {num(v.league_tds_pg, 2)} · {v.games} games · faces {v.offense}</div>
                      </div>
                      <PosBadge pos={v.position} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Top3Card({ t, loading, suffix }: { t?: Top3Response; loading: boolean; suffix: string }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Top Three Watchlist"
        icon={<Target className="h-4 w-4 text-accent" />}
        subtitle={t?.calibrated ? "Highest validated anytime-TD estimates passing every evidence rule" : "Highest research scores passing every evidence rule"}
        action={<Link to={`/parlay${suffix}`}><Button size="sm" variant="outline">Builder <ArrowRight className="h-3.5 w-3.5" /></Button></Link>}
      />
      {loading && <LoadingBlock rows={3} className="p-5" />}
      {t && !t.run_id && <NoDataState reason={t.empty_reason} />}
      {t?.run_id && t.legs.length === 0 && (
        <div className="p-5"><Notice tone="warn" title="No leg met every evidence rule">The shortlist returns fewer than three when evidence is insufficient.</Notice></div>
      )}
      <div className="divide-y divide-line">
        {t?.legs.map((l, i) => (
          <div key={l.player_id} className="grid gap-4 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:p-5">
            <div className="flex items-center gap-3 sm:block">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 font-display text-sm font-bold text-accent">{i + 1}</div>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/players/${l.player_id}${suffix}`} className="font-display text-lg font-semibold hover:text-accent">{l.player_name}</Link>
                <PosBadge pos={l.position} />
                <span className="text-sm text-muted">{l.team} vs {l.opponent}</span>
                <ConfidenceBadge c={l.confidence} />
              </div>
              <div className="mt-2"><ReasonList reasons={l.reasons} limit={5} /></div>
              <Flags flags={l.flags} className="mt-2" />
              {l.p_model != null && l.p_model >= 0.7 && (
                <p className="mt-2 text-xs text-warn">Few historical predictions were this high; the top of the calibration curve is thinly sampled.</p>
              )}
            </div>
            <div className="sm:text-right"><Estimate p={l.p_model} score={l.score} calibrated={!!t.calibrated} size="lg" /><div className="mt-1 text-xs text-muted">Rank #{l.rank}</div></div>
          </div>
        ))}
      </div>
      {t?.run_id && (
        <div className="border-t border-line bg-bg/30 px-5 py-3 text-xs text-muted">
          Data cutoff {t.data_cutoff ?? "—"} · generated {chicago(t.as_of)} · research only, never guaranteed. Re-check injury reports before kickoff.
        </div>
      )}
    </Card>
  );
}

function PerformanceCard({ p, loading, suffix }: { p: Overview["model_performance"]; loading: boolean; suffix: string }) {
  return (
    <Card>
      <CardHeader title="Walk-forward performance" icon={<TrendingUp className="h-4 w-4 text-muted" />}
        subtitle="Unseen weeks only; each week predicted from earlier data"
        action={<Link to={`/backtest${suffix}`} className="text-xs text-accent hover:underline">Details</Link>} />
      <CardBody>
        {loading && <LoadingBlock rows={2} />}
        {!loading && !p && <p className="text-sm text-muted">No genuine backtest yet. It appears after a full import.</p>}
        {p && (
          <>
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Top-3 hit rate" value={pct(p.top3.hit_rate)} sub={`${p.top3.hits}/${p.top3.graded} picks`} />
              <Stat label="Brier" value={num(p.overall.brier, 3)} sub={`baseline ${num(p.baseline.brier, 3)}`} />
              <Stat label="Log loss" value={num(p.overall.log_loss, 3)} sub={`baseline ${num(p.baseline.log_loss, 3)}`} />
            </div>
            <div className="mt-4 flex items-end gap-1.5" aria-label="Top-3 hits in the last six tested weeks">
              {p.recent_weeks.map((w) => (
                <div key={`${w.season}-${w.week}`} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex w-full flex-col-reverse gap-0.5">
                    {Array.from({ length: w.graded }).map((_, i) => (
                      <div key={i} className={cn("h-2.5 rounded-sm", i < w.hits ? "bg-accent" : "bg-line")} />
                    ))}
                  </div>
                  <span className="text-[10px] text-muted">{String(w.season).slice(2)}·W{w.week}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted">{p.top3.hits} of {p.top3.graded} top-3 picks scored across {p.top3_policy.weeks} test weeks (95% CI {pct(p.top3.ci[0])}–{pct(p.top3.ci[1])}). Model: {p.model}.</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
