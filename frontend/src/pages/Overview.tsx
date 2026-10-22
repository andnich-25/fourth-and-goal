import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowRight, BadgeDollarSign, ChevronDown, Crosshair, Dices, ShieldAlert, Target, TrendingUp } from "lucide-react";
import { api } from "@/lib/api";
import { chicago, cn, kickoff, num, pct } from "@/lib/format";
import { tierFor, useConfidence } from "@/lib/confidence";
import { feedLine, useFeed } from "@/lib/feed";
import { pOver, type PropDist } from "@/lib/props";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import type { ProbMetrics, RankingsResponse, Top3Response, TopN, TopPolicy } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { Button, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, PosBadge, Skeleton, Stat, TeamBadge } from "@/components/ui";
import { Estimate, Flags, NoDataState, ReasonList, TierBadge } from "@/components/shared";

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

      {d && !d.data_loaded && <Card><NoDataState /></Card>}
      {d?.error && <Notice tone="danger" title="Last data refresh stopped">{d.error}</Notice>}
      {completed && <Notice tone="info">This week is finished. The picks were made before kickoff using earlier games only; results are shown.</Notice>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Top3Card t={d?.top3} loading={q.isLoading} suffix={suffix} />
        <div className="space-y-5">
          <ValueCard season={season} week={week} suffix={suffix} />
          {week > 1 && <LastWeekCard season={season} week={week - 1} suffix={suffix} />}
          <TrackRecordCard p={d?.model_performance ?? null} loading={q.isLoading} suffix={suffix} />
        </div>
      </div>

      <Card>
        <CardHeader title="This week's games" subtitle="Projected points for each team, from the betting line" />
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
            </div>
          ))}
        </div>
      </Card>

      <details className="card group">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium sm:px-5">
          More research for this week <ChevronDown className="h-4 w-4 text-muted transition-transform group-open:rotate-180" />
        </summary>
        <div className="grid gap-5 border-t border-line p-4 sm:p-5 lg:grid-cols-2">
          <div>
            <div className="label mb-2 flex items-center gap-2"><Crosshair className="h-3.5 w-3.5 text-accent" />Most red-zone chances per game</div>
            <ul className="divide-y divide-line">
              {d?.opportunity_leaders.map((o) => (
                <li key={o.player_id}>
                  <Link to={`/players/${o.player_id}${suffix}`} className="flex items-center gap-3 py-2 hover:text-accent">
                    <TeamBadge team={o.team} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{o.player_name} <span className="text-muted">vs {o.opponent}</span></div>
                      <div className="text-xs text-muted">{num(o.rz_carries_pg)} red-zone carries · {num(o.rz_targets_pg)} red-zone targets per game</div>
                    </div>
                    <PosBadge pos={o.position} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="label mb-2 flex items-center gap-2"><ShieldAlert className="h-3.5 w-3.5 text-warn" />Defenses allowing the most TDs to a position</div>
            <ul className="divide-y divide-line">
              {d?.defense_vulnerabilities.map((v) => (
                <li key={v.defense + v.position}>
                  <Link to={`/defenses/${v.defense}${suffix}`} className="flex items-center gap-3 py-2 hover:text-accent">
                    <TeamBadge team={v.defense} />
                    <div className="min-w-0 flex-1 text-sm">{num(v.tds_pg, 2)} {v.position} TDs per game (league {num(v.league_tds_pg, 2)})
                      <div className="text-xs text-muted">{v.games} games · faces {v.offense}</div></div>
                    <PosBadge pos={v.position} />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">Across 2019–2025, a defense's TDs allowed barely repeated from one half of the season to the other, so the model only nudges for it. See <Link className="text-accent" to={`/trends${suffix}`}>Trends</Link>.</p>
          </div>
        </div>
      </details>
    </div>
  );
}

function Top3Card({ t, loading, suffix }: { t?: Top3Response; loading: boolean; suffix: string }) {
  const conf = useConfidence();
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Top 3 touchdown picks"
        icon={<Target className="h-4 w-4 text-accent" />}
        subtitle="Most likely to score a rushing or receiving TD, one per game, healthy and playing regularly"
        action={<Link to={`/parlay${suffix}`}><Button size="sm" variant="outline">Lock picks <ArrowRight className="h-3.5 w-3.5" /></Button></Link>}
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
              </div>
              <div className="mt-1.5"><TierBadge tier={tierFor(conf.data, "td", l.p_model)} /></div>
              <div className="mt-2"><ReasonList reasons={l.reasons} limit={3} /></div>
              <Flags flags={l.flags} className="mt-2" />
              {l.p_model != null && l.p_model >= 0.7 && (
                <p className="mt-2 text-xs text-warn">Few past predictions were this high, so this chance is less certain than lower ones.</p>
              )}
            </div>
            <div className="sm:text-right"><Estimate p={l.p_model} score={l.score} calibrated={!!t.calibrated} size="lg" /><div className="mt-1 text-xs text-muted">Rank #{l.rank}</div></div>
          </div>
        ))}
      </div>
      {t?.run_id && (
        <div className="border-t border-line bg-bg/30 px-5 py-3 text-xs text-muted">
          Updated {chicago(t.as_of)} · never guaranteed · re-check injury news before kickoff.
        </div>
      )}
    </Card>
  );
}

type ValueRow = { key: string; player_id: string; name: string; team: string; position: string; label: string; chance: number;
  price: number; book: string; edge: number; kind: "td" | "props" };
type PropsLite = { rows: { player_id: string; player_name: string; team: string; position: string; eligible: number; dist: PropDist | null }[] };

/** Legs where our chance is furthest above the chance implied by the best price any book offers. */
function ValueCard({ season, week, suffix }: { season: number; week: number; suffix: string }) {
  const feed = useFeed(season, week);
  const conf = useConfidence();
  const ranks = useQuery({ queryKey: ["rankings-all", season, week], queryFn: () => api.get<RankingsResponse>("/rankings", { season, week, eligible_only: true, page_size: 2000, sort: "rank", order: "asc" }) });
  const markets = useQuery({ queryKey: ["props-markets"], queryFn: () => api.get<{ markets: { market: string; label: string; validated: boolean }[] }>("/props/markets") });
  const validated = (markets.data?.markets ?? []).filter((m) => m.validated);
  const props = useQueries({ queries: validated.map((m) => ({ queryKey: ["props", season, week, m.market], enabled: !!feed.at,
    queryFn: () => api.get<PropsLite>("/props", { season, week, market: m.market }) })) });
  const rows: ValueRow[] = [];
  const best = (list: { book: string; price: number }[]) => list.reduce<{ book: string; price: number } | null>((b, r) => (!b || dec(r.price) > dec(b.price) ? r : b), null);
  if (feed.at) {
    for (const r of ranks.data?.rows ?? []) {
      if (r.p_model == null) continue;
      const b = best(feed.get("td", r.player_id, "yes"));
      if (b) rows.push({ key: `td:${r.player_id}`, player_id: r.player_id, name: r.player_name, team: r.team, position: r.position, label: "Anytime TD",
        chance: r.p_model, price: b.price, book: b.book, edge: r.p_model - 1 / dec(b.price), kind: "td" });
    }
    validated.forEach((m, i) => {
      for (const r of props[i]?.data?.rows ?? []) {
        if (!r.dist || !r.eligible) continue;
        const line = feedLine(feed, m.market, r.player_id);
        if (line == null) continue;
        const over = pOver(r.dist, line);
        for (const side of ["over", "under"] as const) {
          const b = best(feed.get(m.market, r.player_id, side).filter((x) => x.line === line));
          if (!b) continue;
          const chance = side === "over" ? over : 1 - over;
          rows.push({ key: `${m.market}:${r.player_id}:${side}`, player_id: r.player_id, name: r.player_name, team: r.team, position: r.position,
            label: `${side === "over" ? "Over" : "Under"} ${line} ${m.label.toLowerCase()}`, chance, price: b.price, book: b.book,
            edge: chance - 1 / dec(b.price), kind: "props" });
        }
      }
    });
  }
  rows.sort((a, b) => b.edge - a.edge);
  const top = rows.filter((r) => r.edge >= MIN_EDGE).slice(0, 6);
  return (
    <Card>
      <CardHeader title="Best prices vs our chances" icon={<BadgeDollarSign className="h-4 w-4 text-accent" />}
        subtitle={feed.at ? `Best price across US books, ${chicago(feed.at)}` : "Sportsbook prices"} />
      {!feed.at ? <CardBody className="text-sm text-muted">Prices appear here after the weekly price pull (Saturday morning). Until then, type prices into the parlay builder.</CardBody>
        : !top.length ? <CardBody className="text-sm text-muted">No leg clears the bar this week (our chance at least {pct(MIN_EDGE, 0)} above the best price). Passing is part of winning: book prices are sharp.</CardBody> : (
          <ul className="divide-y divide-line">{top.map((r) => (
            <li key={r.key} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium"><Link className="hover:text-accent" to={`/players/${r.player_id}${suffix}`}>{r.name}</Link> <span className="text-xs text-muted">{r.team}</span></div>
                <div className="text-xs text-muted">{r.label} · {r.price > 0 ? `+${r.price}` : r.price} at {r.book}</div>
              </div>
              <div className="text-right"><div className="text-sm font-semibold">{pct(r.chance, 0)} <span className="font-normal text-muted">vs {pct(1 / dec(r.price), 0)}</span></div>
                <TierBadge tier={tierFor(conf.data, r.kind, r.kind === "td" ? r.chance : Math.max(r.chance, 1 - r.chance))} compact /></div>
            </li>))}</ul>)}
      {feed.at && <div className="border-t border-line px-4 py-2 text-[11px] text-muted sm:px-5">"vs" is the chance the price implies, which includes the book's margin. A gap is not a sure thing.</div>}
    </Card>
  );
}
// Our chance must beat the best price by this much before a leg is shown: covers the book margin and model error.
const MIN_EDGE = 0.03;
const dec = (american: number) => 1 + (american > 0 ? american / 100 : 100 / -american);

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
            <p className="mt-3 text-xs text-muted">{p.top3.hits} of {p.top3.graded} top-3 picks scored across {p.top3_policy.weeks} test weeks (95% CI {pct(p.top3.ci[0])}–{pct(p.top3.ci[1])}). Model: {p.model}.</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}
