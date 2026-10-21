import * as React from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Download, Lock, RotateCcw, ShieldCheck } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { americanToProb, chicago, cn, decimalToProb, num, pct } from "@/lib/format";
import { useLinkSuffix, usePins, useSeasonWeek } from "@/lib/state";
import type { Leg, Reason, Top3Response } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { Badge, Button, Card, CardBody, CardHeader, ErrorState, Input, LoadingBlock, Notice, PosBadge, Segmented, TeamBadge } from "@/components/ui";
import { ConfidenceBadge, Estimate, Flags, ModelBadge, NoDataState, ReasonList } from "@/components/shared";

type OddsState = Record<string, { odds: string; fmt: "american" | "decimal" }>;
type LockAudit = {
  lock_id: string; created_at: string; season: number; week: number; model_version: string; calibrated: boolean; data_cutoff: string; note: string | null;
  legs: (Leg & { odds_input: string | null; implied_market_prob: number | null; result: string; touchdowns: number | null })[];
  summary: { hits: number; misses: number; pending: number; voids: number; all_hit: boolean | null };
};
type PlayerResp = { player_id: string; player_name: string; position: string; team: string; prediction: null | {
  rank: number; score: number; p_model: number | null; calibrated: boolean; eligible: boolean; exclusion: string | null; confidence: string;
  flags: string[]; reasons: Reason[]; opponent: string; game_id: string; team: string; features: Record<string, unknown> } };

export default function ParlayPage() {
  const { season, week } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const pins = usePins();
  const qc = useQueryClient();
  const [exclude, setExclude] = React.useState<string[]>([]);
  const [mode, setMode] = React.useState<"suggested" | "pins">("suggested");
  const [odds, setOdds] = React.useState<OddsState>({});
  const [note, setNote] = React.useState("");
  React.useEffect(() => setExclude([]), [season, week]);

  const top = useQuery({ queryKey: ["top3", season, week, exclude], queryFn: () => api.get<Top3Response>("/weekly-top3", { season, week, exclude }) });
  const weekPins = pins.pins.filter((p) => p.season === season && p.week === week);
  const pinQs = useQueries({ queries: weekPins.map((p) => ({ queryKey: ["player", p.player_id, season, week], queryFn: () => api.get<PlayerResp>(`/players/${p.player_id}`, { season, week }) })) });
  const t = top.data;
  const calibrated = !!t?.calibrated;

  const pinnedLegs: Leg[] = pinQs.flatMap((q) => {
    const d = q.data;
    if (!d?.prediction) return [];
    const p = d.prediction;
    return [{ player_id: d.player_id, player_name: d.player_name, team: p.team, opponent: p.opponent, position: d.position, game_id: p.game_id,
      rank: p.rank, score: p.score, p_model: p.p_model, confidence: p.confidence, flags: p.flags, reasons: p.reasons,
      kickoff_utc: null, started: false }];
  });
  const legs = mode === "pins" ? pinnedLegs : t?.legs ?? [];
  const sameGame = new Set(legs.map((l) => l.game_id)).size !== legs.length;

  const implied = (id: string) => {
    const o = odds[id];
    if (!o?.odds) return null;
    return o.fmt === "decimal" ? decimalToProb(o.odds) : americanToProb(o.odds);
  };
  const joint = calibrated && legs.length > 0 && legs.every((l) => l.p_model != null) ? legs.reduce((a, l) => a * (l.p_model as number), 1) : null;
  const jointImplied = legs.length > 0 && legs.every((l) => implied(l.player_id) != null) ? legs.reduce((a, l) => a * (implied(l.player_id) as number), 1) : null;

  const lock = useMutation({
    mutationFn: () => api.post<{ lock_id: string }>("/weekly-top3/lock", {
      season, week, note: note || null,
      legs: legs.map((l) => ({ player_id: l.player_id, team: l.team, odds: odds[l.player_id]?.odds || null, odds_format: odds[l.player_id]?.odds ? odds[l.player_id].fmt : null })),
    }),
    onSuccess: () => { setNote(""); qc.invalidateQueries({ queryKey: ["locks"] }); },
  });
  const locks = useQuery({ queryKey: ["locks", season], queryFn: () => api.get<LockAudit[]>("/locks", { season }) });

  return (
    <div className="space-y-5">
      <PageTitle kicker={`${season} · Week ${week}`} title="Top 3 builder">
        {t?.run_id && <ModelBadge version={t.model_version} calibrated={calibrated} />}
      </PageTitle>

      <Notice tone="info" title="How this works">
        Up to three eligible players that pass every evidence rule, one per game. Fewer are returned when evidence is thin. Odds are optional and
        informational. Locking freezes a pregame snapshot for later audit; it is not a recommendation to stake anything, and no selection is guaranteed.
      </Notice>

      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Leg source" value={mode} onChange={setMode}
          options={[{ value: "suggested", label: "Suggested" }, { value: "pins", label: `My pins (${weekPins.length})` }]} />
        {mode === "suggested" && exclude.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setExclude([])}><RotateCcw className="h-3.5 w-3.5" /> Restore {exclude.length} excluded</Button>
        )}
        {mode === "pins" && weekPins.length === 0 && <span className="text-sm text-muted">Pin up to three players on the <Link className="text-accent" to={`/rankings${suffix}`}>Rankings</Link> page.</span>}
      </div>

      {top.isError && <Card><ErrorState error={top.error} onRetry={() => top.refetch()} /></Card>}
      {top.isLoading && <Card><LoadingBlock rows={3} className="p-5" /></Card>}
      {t && !t.run_id && <Card><NoDataState reason={t.empty_reason} /></Card>}
      {t?.run_id && legs.length === 0 && mode === "suggested" && (
        <Notice tone="warn" title="No candidate met every rule">That is a valid outcome: the builder does not pad the slate with weaker legs.</Notice>
      )}
      {sameGame && <Notice tone="warn">Two legs share a game. Same-game outcomes are correlated; locking requires one leg per game.</Notice>}

      <div className="grid gap-4 lg:grid-cols-3">
        {legs.map((l, i) => {
          const imp = implied(l.player_id);
          const o = odds[l.player_id] ?? { odds: "", fmt: "american" as const };
          return (
            <Card key={l.player_id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3 border-b border-line p-4">
                <div className="min-w-0">
                  <div className="label">Leg {i + 1} · rank #{l.rank}</div>
                  <Link to={`/players/${l.player_id}${suffix}`} className="mt-1 block truncate font-display text-lg font-semibold hover:text-accent">{l.player_name}</Link>
                  <div className="mt-1 flex items-center gap-2 text-sm text-muted"><TeamBadge team={l.team} /><PosBadge pos={l.position} /> vs {l.opponent}</div>
                </div>
                <Estimate p={l.p_model} score={l.score} calibrated={calibrated} />
              </div>
              <div className="flex-1 space-y-3 p-4">
                <div className="flex flex-wrap gap-1.5"><ConfidenceBadge c={l.confidence} />{l.kickoff_utc && <Badge>{chicago(l.kickoff_utc)}</Badge>}</div>
                <ReasonList reasons={l.reasons} />
                <Flags flags={l.flags} />
                <div className="rounded-lg border border-line p-3">
                  <div className="label mb-2">Manual anytime-TD odds (optional)</div>
                  <div className="flex gap-2">
                    <Input aria-label={`Odds for ${l.player_name}`} placeholder={o.fmt === "american" ? "+150" : "2.50"} value={o.odds}
                      onChange={(e) => setOdds({ ...odds, [l.player_id]: { ...o, odds: e.target.value } })} className="w-28" />
                    <Segmented size="sm" label="Odds format" value={o.fmt} onChange={(fmt) => setOdds({ ...odds, [l.player_id]: { ...o, fmt } })}
                      options={[{ value: "american", label: "US" }, { value: "decimal", label: "Dec" }]} />
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted">Implied (incl. vig)</dt><dd className="num text-right">{imp != null ? pct(imp, 1) : o.odds ? "invalid" : "—"}</dd>
                    <dt className="text-muted">Estimate source</dt><dd className="truncate text-right">{calibrated ? t?.model_version : "research rank"}</dd>
                    {calibrated && imp != null && l.p_model != null && (<><dt className="text-muted">Model − implied</dt><dd className={cn("num text-right", l.p_model - imp >= 0 ? "text-accent" : "text-danger")}>{(100 * (l.p_model - imp)).toFixed(1)} pts</dd></>)}
                  </dl>
                </div>
              </div>
              {mode === "suggested" && (
                <div className="border-t border-line p-3">
                  <Button size="sm" variant="ghost" onClick={() => setExclude([...exclude, l.player_id])}><Ban className="h-3.5 w-3.5" /> Exclude &amp; replace</Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {legs.length > 0 && (
        <Card>
          <CardHeader title="Slate summary" icon={<ShieldCheck className="h-4 w-4 text-accent" />} />
          <CardBody className="grid gap-5 md:grid-cols-[1fr_1fr_1.2fr]">
            <div>
              <div className="label">Joint chance (all legs score)</div>
              {joint != null ? (
                <>
                  <div className="num mt-1 font-display text-3xl font-semibold">{pct(joint, 1)}</div>
                  <Badge tone="warn" className="mt-2">Simplistic independence product</Badge>
                  <p className="mt-2 text-xs text-muted">{t?.joint?.note ?? "Product of individual estimates; ignores correlation and was not validated as a parlay probability."}</p>
                </>
              ) : (
                <p className="mt-1 text-sm text-muted">{calibrated ? "Needs a validated estimate for every leg." : "Hidden: individual probabilities are not validated."}</p>
              )}
            </div>
            <div>
              <div className="label">Market implied (product)</div>
              <div className="num mt-1 font-display text-3xl font-semibold">{jointImplied != null ? pct(jointImplied, 1) : "—"}</div>
              <p className="mt-2 text-xs text-muted">From your entered odds; includes bookmaker margin and the same independence simplification.</p>
              {t?.walk_forward_top3_policy && (
                <p className="mt-2 text-xs text-muted">Backtest of this rule set: all three legs scored in {t.walk_forward_top3_policy.all3_hits} of {t.walk_forward_top3_policy.weeks_with_3_legs} three-leg weeks ({pct(t.walk_forward_top3_policy.all3_rate)}); individual legs {pct(t.walk_forward_top3_policy.leg_hit_rate)}.</p>
              )}
            </div>
            <div className="space-y-2">
              <div className="label">Lock pregame snapshot</div>
              <Input aria-label="Lock note" placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              <Button variant="primary" onClick={() => lock.mutate()} loading={lock.isPending} disabled={sameGame || legs.length === 0}>
                <Lock className="h-4 w-4" /> Lock picks ({legs.length})
              </Button>
              {lock.isSuccess && <p className="text-xs text-accent">Locked as {lock.data.lock_id}. Snapshots cannot be edited.</p>}
              {lock.isError && <p className="text-xs text-danger">{lock.error instanceof ApiError ? lock.error.message : String(lock.error)}</p>}
              <p className="text-xs text-muted">Stores season, week, model version, data cutoff, each leg's estimate and odds, and a UTC timestamp. Kickoff must not have passed.</p>
            </div>
          </CardBody>
        </Card>
      )}

      {t?.rules && (
        <Card>
          <CardHeader title="Evidence rules" subtitle={t.run_id ? `${t.passed_rules ?? 0} of ${t.considered ?? 0} eligible players pass the rules; ${t.passed_floor ?? 0} also clear the evidence floor` : undefined} />
          <CardBody><ol className="list-decimal space-y-1 pl-5 text-sm text-muted">{t.rules.map((r) => <li key={r}>{r}</li>)}</ol></CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Locked selections" subtitle="Immutable pregame snapshots, graded once games finish"
          action={<Button size="sm" variant="outline" onClick={() => api.download("/export/locks.csv")}><Download className="h-3.5 w-3.5" /> CSV</Button>} />
        {locks.isLoading && <LoadingBlock className="p-4" />}
        {locks.data?.length === 0 && <p className="p-5 text-sm text-muted">Nothing locked for {season} yet.</p>}
        <ul className="divide-y divide-line">
          {locks.data?.map((lk) => (
            <li key={lk.lock_id} className="p-4 sm:px-5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">Week {lk.week}</span>
                <span className="text-muted">locked {chicago(lk.created_at)} · {lk.model_version} · cutoff {lk.data_cutoff}</span>
                <span className="flex-1" />
                <Badge tone={lk.summary.pending ? "neutral" : lk.summary.all_hit ? "accent" : "neutral"}>
                  {lk.summary.hits} hit · {lk.summary.misses} miss{lk.summary.voids ? ` · ${lk.summary.voids} void` : ""}{lk.summary.pending ? ` · ${lk.summary.pending} pending` : ""}
                </Badge>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {lk.legs.map((l) => (
                  <span key={l.player_id} className="rounded-md border border-line px-2 py-1 text-xs">
                    {l.player_name} <span className="text-muted">{lk.calibrated && l.p_model != null ? pct(l.p_model) : `score ${num(l.score, 0)}`}{l.odds_input ? ` · ${l.odds_input}` : ""}</span>{" "}
                    <span className={cn(l.result === "hit" ? "text-accent" : l.result === "miss" ? "text-danger" : "text-muted")}>{l.result}</span>
                  </span>
                ))}
              </div>
              {lk.note && <p className="mt-1 text-xs text-muted">“{lk.note}”</p>}
            </li>
          ))}
        </ul>
      </Card>
      <p className="text-center text-xs text-muted">Times shown in Central time.</p>
    </div>
  );
}
