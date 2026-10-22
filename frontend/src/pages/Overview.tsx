import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, MessageCircleQuestion, Dices, Target, TrendingUp } from "lucide-react";
import { api } from "@/lib/api";
import { chicago, cn, kickoff, num, pct } from "@/lib/format";
import { tierFor, useConfidence } from "@/lib/confidence";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import { anyPool, isProven } from "@/lib/ask";
import { useAskData } from "@/pages/Ask";
import type { ProbMetrics, RankingsResponse, Top3Response, TopN, TopPolicy } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { Button, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, PosBadge, Skeleton, Stat, TeamBadge } from "@/components/ui";
import { NoDataState, TierBadge } from "@/components/shared";

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
      <PageTitle kicker={`${season} · data through ${d?.latest_completed_gameday ?? "…"}`} title={`Week ${week} picks`}>
        <Link to={`/builder${suffix}`}><Button variant="primary"><Dices className="h-4 w-4" />Build a parlay</Button></Link>
      </PageTitle>

      <AskBar suffix={suffix} />
      {d && !d.data_loaded && <Card><NoDataState /></Card>}
      {d?.error && <Notice tone="danger" title="Last data refresh stopped">{d.error}</Notice>}
      {completed && <Notice tone="info">This week is finished. The picks were made before kickoff using earlier games only; results are shown.</Notice>}

      <div className="flex gap-2 overflow-x-auto pb-1">
        {q.isLoading && Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-36 shrink-0" />)}
        {d?.games.map((g) => (
          <div key={g.game_id} className="min-w-[150px] shrink-0 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            <div className="flex items-center gap-1.5"><TeamBadge team={g.away} /><span className="text-muted">@</span><TeamBadge team={g.home} />
              {g.home_score != null && <span className="num ml-auto text-xs font-medium">{g.away_score}–{g.home_score}</span>}</div>
            <div className="mt-1 text-xs text-muted">{kickoff(g.gameday, g.gametime)}{g.total ? ` · O/U ${g.total}` : ""}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <StrongestCard season={season} week={week} suffix={suffix} />
        <div className="space-y-5">
          <Top3Card t={d?.top3} loading={q.isLoading} suffix={suffix} />
          {week > 1 && <LastWeekCard season={season} week={week - 1} suffix={suffix} />}
          <TrackRecordCard p={d?.model_performance ?? null} loading={q.isLoading} suffix={suffix} />
        </div>
      </div>
    </div>
  );
}

/** The week's strongest picks in any market (anytime TD and every prop), only from tiers that hit 50%+ on unseen weeks.
 *  Same pool as Ask's "safest picks" answer, so the two always agree. */
function StrongestCard({ season, week, suffix }: { season: number; week: number; suffix: string }) {
  const { data, loading } = useAskData(season, week);
  const picks = data ? anyPool(data).filter((p) => isProven(data, p)).slice(0, 12) : [];
  const strong = data?.conf?.props?.tiers.find((t) => t.tier === "Strong");
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Strongest picks this week" icon={<Target className="h-4 w-4 text-accent" />}
        subtitle={strong?.rate != null ? `Strong prop picks hit ${pct(strong.rate, 0)} of ${strong.n.toLocaleString()} unseen games in testing. One pick per player.` : "One pick per player, strongest first."} />
      {loading && <LoadingBlock rows={6} className="p-5" />}
      {!loading && !picks.length && <CardBody className="text-sm text-muted">No pick reaches a proven confidence level yet this week.</CardBody>}
      <div className="divide-y divide-line/60">
        {picks.map((p) => (
          <Link key={p.id} to={`/players/${p.player_id}${suffix}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-raised/50 sm:flex-nowrap sm:px-5">
            <div className="min-w-0 flex-1 basis-44">
              <div className="flex items-center gap-2 font-medium"><span className="truncate">{p.name}</span><PosBadge pos={p.pos} /></div>
              <div className="text-xs text-muted">{p.team} vs {p.opp}{p.lineSource === "usual" ? " · usual line" : p.lineSource === "book" ? " · book line" : ""}</div>
            </div>
            <div className="ml-auto text-right">
              <div className="font-semibold">{p.label}</div>
              <div className="flex items-center justify-end gap-1.5 text-xs text-muted"><span className="font-bold text-fg">{pct(p.p, 0)}</span><TierBadge tier={p.tierData ?? null} compact /></div>
            </div>
          </Link>
        ))}
      </div>
      {!!picks.length && (
        <div className="border-t border-line bg-bg/30 px-5 py-3 text-xs text-muted">
          Never guaranteed. Re-check injury news before kickoff. <Link to={`/props${suffix}`} className="text-accent hover:underline">See every player</Link>
        </div>
      )}
    </Card>
  );
}

function Top3Card({ t, loading, suffix }: { t?: Top3Response; loading: boolean; suffix: string }) {
  const conf = useConfidence();
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Top 3 touchdown picks"
        icon={<Target className="h-4 w-4 text-accent" />}
        subtitle="Most likely to score, one per game"
      />
      {loading && <LoadingBlock rows={3} className="p-5" />}
      {t && !t.run_id && <NoDataState reason={t.empty_reason} />}
      {t?.run_id && t.legs.length === 0 && (
        <div className="p-5"><Notice tone="warn" title="No leg met every evidence rule">The shortlist returns fewer than three when evidence is insufficient.</Notice></div>
      )}
      <div className="divide-y divide-line/60">
        {t?.legs.map((l, i) => (
          <Link key={l.player_id} to={`/players/${l.player_id}${suffix}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised/50 sm:px-5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 font-display text-sm font-bold text-accent">{i + 1}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-medium"><span className="truncate">{l.player_name}</span><PosBadge pos={l.position} /></div>
              <div className="text-xs text-muted">{l.team} vs {l.opponent}</div>
            </div>
            <div className="text-right">
              <div className="num font-semibold">{t.calibrated && l.p_model != null ? pct(l.p_model, 0) : num(l.score, 0)}</div>
              <TierBadge tier={tierFor(conf.data, "td", l.p_model)} compact />
            </div>
          </Link>
        ))}
      </div>
      {t?.run_id && (
        <div className="border-t border-line bg-bg/30 px-5 py-3 text-xs text-muted">
          Updated {chicago(t.as_of)}
        </div>
      )}
    </Card>
  );
}

/** Last week's picks, graded: the Top 3 and how each confidence tier did. */
function LastWeekCard({ season, week, suffix }: { season: number; week: number; suffix: string }) {
  const conf = useConfidence();
  const top = useQuery({ queryKey: ["top3", season, week, []], queryFn: () => api.get<Top3Response>("/weekly-top3", { season, week, exclude: [] }) });
  const ranks = useQuery({ queryKey: ["rankings-full", season, week], queryFn: () => api.get<RankingsResponse>("/rankings", { season, week, eligible_only: false, page_size: 2000 }) });
  const byId = new Map((ranks.data?.rows ?? []).map((r) => [r.player_id, r]));
  const legs = (top.data?.legs ?? []).map((l) => ({ ...l, row: byId.get(l.player_id) }));
  if (!legs.length || legs.every((l) => l.row?.outcome == null)) return null;
  const graded = (ranks.data?.rows ?? []).filter((r) => r.eligible && r.p_model != null && r.participated === 1 && r.outcome != null);
  const tiers = (conf.data?.td?.tiers ?? []).map((t) => {
    const g = graded.filter((r) => tierFor(conf.data, "td", r.p_model)?.tier === t.tier);
    return { tier: t, n: g.length, hits: g.filter((r) => r.outcome === 1).length, expected: g.reduce((a, r) => a + (r.p_model as number), 0) };
  }).filter((x) => x.n > 0 && x.tier.tier !== "Long shot");
  return (
    <Card>
      <CardHeader title={`Last week (Week ${week})`} subtitle="How the picks made before kickoff turned out" />
      <ul className="divide-y divide-line">{legs.map((l) => (
        <li key={l.player_id} className="flex items-center gap-3 px-4 py-2 text-sm sm:px-5">
          <Link className="min-w-0 flex-1 truncate hover:text-accent" to={`/players/${l.player_id}${suffix}`}>{l.player_name} <span className="text-xs text-muted">{l.team}</span></Link>
          <span className="text-muted">{pct(l.p_model, 0)}</span>
          <span className={cn("w-16 text-right font-semibold", l.row?.participated !== 1 ? "text-muted" : l.row?.outcome === 1 ? "text-ok" : "text-danger")}>
            {l.row?.participated !== 1 ? "Void" : l.row?.outcome === 1 ? "Scored" : "No TD"}</span>
        </li>))}</ul>
      {tiers.length > 0 && <div className="border-t border-line px-4 py-2 text-xs text-muted sm:px-5">
        {tiers.map((x) => <span key={x.tier.tier} className="mr-3">{x.tier.tier}: <b className="text-fg">{x.hits}/{x.n}</b> scored (expected {num(x.expected, 1)})</span>)}
      </div>}
    </Card>
  );
}

function TrackRecordCard({ p, loading, suffix }: { p: Overview["model_performance"]; loading: boolean; suffix: string }) {
  const conf = useConfidence();
  const td = conf.data?.td;
  return (
    <Card>
      <CardHeader title="Track record" icon={<TrendingUp className="h-4 w-4 text-muted" />}
        subtitle={td ? `Every week since ${td.first_season}, predicted using only earlier games` : "Weeks the model had never seen"}
        action={<Link to={`/backtest${suffix}`} className="text-xs text-accent hover:underline">Details</Link>} />
      <CardBody>
        {loading && <LoadingBlock rows={2} />}
        {!loading && !p && <p className="text-sm text-muted">No genuine backtest yet. It appears after a full import.</p>}
        {p && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Top 3 picks that scored" value={pct(p.top3_policy?.leg_hit_rate ?? p.top3.hit_rate)}
                sub={p.top3_policy ? `${p.top3_policy.leg_hits.toLocaleString()} of ${p.top3_policy.legs_graded.toLocaleString()}` : undefined} />
              <Stat label="All 3 scored" value={pct(p.top3_policy?.all3_rate)} sub={p.top3_policy ? `${p.top3_policy.all3_hits} of ${p.top3_policy.weeks_with_3_legs} weeks` : undefined} />
            </div>
            {td && (
              <table className="mt-4 w-full text-sm"><thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted"><th className="pb-1 font-medium">Confidence</th><th className="pb-1 font-medium">Our chance</th><th className="pb-1 text-right font-medium">Actually scored</th></tr></thead>
                <tbody>{td.tiers.map((x) => (
                  <tr key={x.tier} className="border-t border-line/60"><td className="py-1.5"><TierBadge tier={x} compact /></td>
                    <td className="py-1.5 text-muted">{pct(x.lo, 0)}{x.hi >= 1 ? "+" : `–${pct(x.hi, 0)}`}</td>
                    <td className="py-1.5 text-right"><b>{pct(x.rate, 0)}</b> <span className="text-xs text-muted">of {x.n.toLocaleString()}</span></td></tr>))}</tbody></table>
            )}
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
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** Question box on the home page; answers open on the Ask page. */
function AskBar({ suffix }: { suffix: string }) {
  const navigate = useNavigate();
  const [q, setQ] = React.useState("");
  const go = (text: string) => {
    const p = new URLSearchParams(suffix.replace(/^\?/, ""));
    p.set("q", text);
    navigate(`/ask?${p.toString()}`);
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) go(q.trim()); }}
      className="flex items-center gap-2 rounded-xl border border-line bg-surface p-2">
      <MessageCircleQuestion className="ml-1 h-5 w-5 shrink-0 text-accent" aria-hidden />
      <input aria-label="Ask a question" value={q} onChange={(e) => setQ(e.target.value)} placeholder='Ask anything, e.g. "one TD scorer from each game"'
        className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
      <button type="submit" aria-label="Ask" disabled={!q.trim()} className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white disabled:opacity-40"><ArrowUp className="h-4 w-4" /></button>
    </form>
  );
}
