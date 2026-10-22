import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Search } from "lucide-react";
import { api } from "@/lib/api";
import { americanToProb, cn, num, pct } from "@/lib/format";
import { feedLine, useFeed } from "@/lib/feed";
import { MARKET_GROUPS, pOver, type PropDist } from "@/lib/props";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, ErrorState, Input, LoadingBlock, PosBadge, Segmented, Select, TableWrap, Td, TeamBadge, Th } from "@/components/ui";
import { Flags, NoDataState, TierBadge } from "@/components/shared";
import { useConfidence, tierFor } from "@/lib/confidence";
import { overReasons, underReasons, usualLine, type Recent } from "@/lib/ask";

export type MarketMeta = {
  market: string; label: string; positions: string[]; kind: string; validated: boolean; model: string | null; tested: boolean;
  test_rows?: number; test_weeks?: number; crps_gain_pct?: number; mae_median?: number; baseline_mae_median?: number;
  coverage_10_90?: number; coverage_expected?: number; over_ece?: number; lean_n?: number; lean_hit_rate?: number | null; failed_checks?: string[];
};
type PropRow = {
  player_id: string; player_name: string; team: string; opponent: string; position: string; game_id: string; eligible: number;
  exclusion: string | null; flags: string[]; model: string; calibrated: number; mean: number; median: number; q10: number; q90: number;
  dist: PropDist | null; evidence: Record<string, number | null>; actual: number | null; recent?: Recent[];
};
type PropsResp = { season: number; week: number; market: MarketMeta; run_id: string | null; as_of?: string; rows: PropRow[]; note?: string; empty_reason?: string };
type MarketsResp = { markets: MarketMeta[]; note: string };

const CHECK_LABELS: Record<string, string> = {
  enough_rows: "enough test games", enough_weeks: "enough test weeks", beats_baselines_crps: "beats both baselines",
  crps_gain_ci_excludes_zero: "improvement is statistically clear", beats_baselines_over_brier: "better over/under accuracy than baselines",
  over_calibrated: "over/under chances are honest", range_calibrated: "10–90% ranges hold", latest_season_not_worse: "holds up this season",
};
const EVIDENCE_LABELS: Record<string, string> = {
  team_implied_total: "Team implied pts", opp_implied_total: "Opp implied pts", n_games_cur: "Games this season", snap_pct: "Snap share",
  attempts_pg: "Pass att/g", team_attempts_pg: "Team pass att/g", ypa: "Yards/att", comp_pct: "Comp %", carries_pg: "Carries/g",
  carries_share: "Carry share", ypc: "Yards/carry", targets_pg: "Targets/g", targets_share: "Target share", ypt: "Yards/target", catch_rate: "Catch rate",
};

function evidenceLabel(k: string, stat: string, label: string) {
  if (k === `${stat}_pg`) return `${label}: recent avg`;
  if (k === `${stat}_med`) return `${label}: recent median`;
  if (k === `${stat}_l3`) return `${label}: last 3`;
  if (k === `${stat}_cur`) return `${label}: season avg`;
  if (k === `opp_${stat}_mult`) return "Opponent allows vs avg";
  return EVIDENCE_LABELS[k] ?? k;
}
function evidenceValue(k: string, v: number | null) {
  if (v == null) return "—";
  if (k.endsWith("_mult")) return `${v >= 1 ? "+" : ""}${Math.round((v - 1) * 100)}%`;
  if (k.endsWith("share") || k === "snap_pct" || k === "comp_pct" || k === "catch_rate") return pct(v, 0);
  return num(v, 1);
}

const LINES_KEY = "fg-prop-lines-v1";
type Lines = Record<string, { line?: string; odds?: string }>;
function loadLines(): Lines { try { return JSON.parse(localStorage.getItem(LINES_KEY) || "{}"); } catch { return {}; } }

/** Confidence out of 10 is the chance of that side times 10, so the over and under scores always add to 10. */
const score = (p: number) => (p * 10).toFixed(1);
type Show = "all" | "under" | "over";

function ConfidenceSplit({ over }: { over: number }) {
  const under = 1 - over;
  const lean = under > over ? "under" : "over";
  return (
    <div className="flex min-w-[150px] items-center gap-2" title={`Under ${score(under)} / Over ${score(over)} out of 10`}>
      <span className={cn("w-8 text-right tabular-nums", lean === "under" ? "font-bold text-fg" : "text-muted")}>{score(under)}</span>
      <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-raised" aria-hidden>
        <div className={cn("h-full", lean === "under" ? "bg-accent" : "bg-line")} style={{ width: `${under * 100}%` }} />
        <div className={cn("h-full", lean === "over" ? "bg-accent" : "bg-line")} style={{ width: `${over * 100}%` }} />
      </div>
      <span className={cn("w-8 tabular-nums", lean === "over" ? "font-bold text-fg" : "text-muted")}>{score(over)}</span>
    </div>
  );
}

function ScoreGuide() {
  const conf = useConfidence();
  const p = conf.data?.props;
  const side = (s: "over" | "under", name: string) => p?.by_side?.[s].find((t) => t.tier === name);
  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <div className="font-semibold">How to read the confidence scores</div>
          <p className="mt-1 text-sm text-muted">Each player gets an <b className="text-fg">Under</b> score and an <b className="text-fg">Over</b> score out of 10 for the line shown.
            The score is the model's chance of that side, so an 8.7 under is an 87% chance and the over is 1.3. The two always add to 10. The bigger number is the lean and is highlighted.
            The line is the book line when one is loaded, otherwise the player's usual line (his recent median, rounded to a half point), and you can type your own.</p>
        </div>
        {p && (
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {p.tiers.map((t) => {
              const u = side("under", t.tier); const o = side("over", t.tier);
              return (
                <div key={t.tier} className="rounded-lg border border-line p-2.5">
                  <div className="flex items-center justify-between gap-2"><TierBadge tier={t} compact /><span className="text-xs text-muted">{t.hi >= 1 ? `${score(t.lo)}+` : `${score(t.lo)}–${score(t.hi)}`}</span></div>
                  <div className="mt-1.5 text-lg font-semibold">{pct(t.rate, 0)} <span className="text-xs font-normal text-muted">hit in testing</span></div>
                  <div className="text-xs text-muted">{u?.rate != null && `Unders ${pct(u.rate, 0)}`}{o?.rate != null && ` · Overs ${pct(o.rate, 0)}`} · {t.n.toLocaleString()} picks</div>
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export default function PropsPage() {
  const { season, week } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const [market, setMarket] = React.useState("receptions");
  const [search, setSearch] = React.useState("");
  const [show, setShow] = React.useState<Show>("all");
  const [open, setOpen] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<Lines>(loadLines);
  React.useEffect(() => { try { localStorage.setItem(LINES_KEY, JSON.stringify(lines)); } catch { /* ignore */ } }, [lines]);
  const meta = useQuery({ queryKey: ["props-markets"], queryFn: () => api.get<MarketsResp>("/props/markets") });
  const q = useQuery({ queryKey: ["props", season, week, market], queryFn: () => api.get<PropsResp>("/props", { season, week, market }) });
  const conf = useConfidence();
  const d = q.data;
  const m = d?.market;
  const stat = ({ pass_attempts: "attempts", rush_rec_yards: "rush_rec_yards" } as Record<string, string>)[market] ?? market;
  const key = (r: PropRow) => `${season}-${week}-${market}-${r.player_id}`;
  const feed = useFeed(season, week);
  // Typed line wins, then the line most books offer, then the player's usual line. Prices are the best one for the lean side.
  const view = (d?.rows ?? []).filter((r) => !search || r.player_name.toLowerCase().includes(search.toLowerCase())).map((r) => {
    const typed = lines[key(r)] ?? {};
    const fl = feedLine(feed, market, r.player_id);
    const usual = usualLine(r, market) ?? Math.floor(r.median) + 0.5;
    const line = typed.line != null && typed.line !== "" ? Number(typed.line) : fl ?? usual;
    const source = typed.line ? "yours" : fl != null ? "book" : "usual";
    const over = r.dist && Number.isFinite(line) ? pOver(r.dist, line) : null;
    const lean: "over" | "under" | null = over == null ? null : over > 0.5 ? "over" : "under";
    const leanP = over == null ? null : Math.max(over, 1 - over);
    const prices = lean ? feed.get(market, r.player_id, lean).filter((o) => o.line === line).map((o) => o.price) : [];
    const best = prices.length ? Math.max(...prices.map((x) => (x > 0 ? x : -10000 / x))) : null;
    const bestStr = best == null ? undefined : best >= 100 ? `+${Math.round(best)}` : String(Math.round(-10000 / best));
    const odds = typed.odds ?? bestStr;
    const implied = odds ? americanToProb(odds) : null;
    const edge = leanP != null && implied != null ? leanP - implied : null;
    const label = m?.label ?? market;
    const reasons = lean && Number.isFinite(line) ? (lean === "under" ? underReasons : overReasons)(r, market, label, line) : [];
    return { r, typed, line, source, over, lean, leanP, odds, edge, reasons, tier: tierFor(conf.data, "props", leanP) };
  }).filter((v) => show === "all" || v.lean === show)
    .sort((a, b) => Number(!!b.r.eligible) - Number(!!a.r.eligible) || (b.leanP ?? -1) - (a.leanP ?? -1) || b.r.median - a.r.median);
  const hasActual = d?.rows.some((x) => x.actual != null);

  return (
    <div className="space-y-5">
      <PageTitle kicker={`${season} · Week ${week}`} title="Player props">
        <Select aria-label="Market" value={market} onChange={(e) => { setMarket(e.target.value); setOpen(null); }} className="w-56">
          {MARKET_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.markets.map((k) => {
                const mm = meta.data?.markets.find((x) => x.market === k);
                return <option key={k} value={k}>{mm?.label ?? k}{mm ? (mm.validated ? " ✓" : " (research)") : ""}</option>;
              })}
            </optgroup>
          ))}
        </Select>
      </PageTitle>

      {m && <MarketCard m={m} />}
      {m?.validated && <ScoreGuide />}

      {q.isError && <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>}
      {q.isLoading && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {d && !d.run_id && <Card><NoDataState reason={d.empty_reason} /></Card>}
      {d?.run_id && (
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-line p-3 sm:p-4">
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
              <Input aria-label="Search players" placeholder="Search players" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
            </div>
            {m?.validated && <Segmented size="sm" label="Show" value={show} onChange={setShow}
              options={[{ value: "all", label: "All" }, { value: "under", label: "Leaning under" }, { value: "over", label: "Leaning over" }]} />}
            <span className="text-sm text-muted">{view.length} players · {m?.validated ? "strongest lean first, inactive players last" : "research projections only"}</span>
          </div>
          <TableWrap>
            <table className="w-full">
              <thead><tr>
                <Th>Player</Th><Th>Opp</Th><Th className="text-right" title="Middle of the projected range: half of outcomes above, half below">Projection</Th>
                <Th className="text-right" title="80% of outcomes should land in this range">10–90%</Th>
                <Th>Line</Th><Th title="Confidence out of 10 for each side. They add to 10; the bigger one is the lean.">Under · Over (out of 10)</Th><Th>Lean</Th>
                <Th title="Optional: American odds for the lean side. Filled with the best book price when prices are loaded.">Price</Th>
                <Th className="text-right" title="Our chance of the lean side minus the book's implied chance (which includes the book's margin)">vs book</Th>
                {hasActual && <Th className="text-right">Result</Th>}<Th />
              </tr></thead>
              <tbody>
                {view.map(({ r, typed, line, source, over, lean, odds, edge, reasons, tier }) => {
                  const k = key(r);
                  return (
                    <React.Fragment key={r.player_id}>
                      <tr className={cn("border-b border-line/60 hover:bg-raised/50", !r.eligible && "opacity-60")}>
                        <Td>
                          <div className="flex min-w-[170px] items-center gap-2">
                            <TeamBadge team={r.team} /><PosBadge pos={r.position} />
                            <div className="min-w-0">
                              <Link to={`/players/${r.player_id}${suffix}`} className="block truncate font-medium hover:text-accent">{r.player_name}</Link>
                              {r.exclusion && <span className="text-[11px] text-danger">{r.exclusion}</span>}
                            </div>
                          </div>
                        </Td>
                        <Td className="text-muted">{r.opponent}</Td>
                        <Td className="text-right font-semibold">{num(r.median, m?.kind === "count" ? 0 : 1)}</Td>
                        <Td className="text-right text-muted">{num(r.q10, 0)}–{num(r.q90, 0)}</Td>
                        <Td>
                          <Input aria-label={`Line for ${r.player_name}`} inputMode="decimal" placeholder={String(line)} value={typed.line ?? ""}
                            onChange={(e) => setLines({ ...lines, [k]: { ...typed, line: e.target.value } })} className="h-8 w-20" />
                          {source !== "yours" && <div className="mt-0.5 text-[10px] text-muted">{source === "book" ? "book line" : "usual line"}</div>}
                        </Td>
                        <Td>{over != null ? <ConfidenceSplit over={over} /> : r.dist ? <span className="text-muted">—</span> : <span className="text-xs text-muted" title="Not validated">hidden</span>}</Td>
                        <Td>{lean ? <div className="flex items-center gap-1.5 whitespace-nowrap"><span className="font-semibold">{lean === "under" ? "Under" : "Over"} {line}</span>{r.eligible ? <TierBadge tier={tier} compact /> : null}</div> : <span className="text-muted">—</span>}</Td>
                        <Td><Input aria-label={`Price for ${r.player_name}`} placeholder="-110" value={odds ?? ""} disabled={!lean}
                          onChange={(e) => setLines({ ...lines, [k]: { ...typed, odds: e.target.value } })} className="h-8 w-20" /></Td>
                        <Td className={cn("text-right", edge != null && (edge > 0 ? "text-accent" : "text-danger"))}>{edge != null ? `${edge > 0 ? "+" : ""}${Math.round(edge * 100)} pts` : <span className="text-muted">—</span>}</Td>
                        {hasActual && <Td className="text-right">{r.actual != null ? num(r.actual, 0) : "—"}</Td>}
                        <Td><button aria-expanded={open === r.player_id} aria-label="Show why" onClick={() => setOpen(open === r.player_id ? null : r.player_id)} className="rounded p-1 text-muted hover:bg-raised">
                          <ChevronDown className={cn("h-4 w-4 transition", open === r.player_id && "rotate-180")} /></button></Td>
                      </tr>
                      {open === r.player_id && (
                        <tr className="border-b border-line bg-raised/30"><td colSpan={11} className="px-4 py-3">
                          {lean && (
                            <div className="mb-3">
                              <div className="text-sm font-semibold">Why it leans {lean} {line}</div>
                              {reasons.length ? <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">{reasons.map((t) => <li key={t}>{t}</li>)}</ul>
                                : <p className="mt-1 text-sm text-muted">No single factor stands out; the lean comes from the model weighing everything below together.</p>}
                            </div>
                          )}
                          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
                            {Object.entries(r.evidence).map(([ek, v]) => (
                              <div key={ek} className="flex justify-between gap-3"><span className="text-muted">{evidenceLabel(ek, stat, m?.label ?? "")}</span><span className="font-medium">{evidenceValue(ek, v)}</span></div>
                            ))}
                          </div>
                          {!!r.recent?.length && <p className="mt-2 text-xs text-muted">Last {r.recent.length} games, newest first: {r.recent.map((g) => num(g.value, 0)).join(", ")}</p>}
                          <Flags flags={r.flags} className="mt-2" />
                          <p className="mt-2 text-xs text-muted">All numbers come from games before this week. Model {r.model}; mean projection {num(r.mean, 1)}. Typed lines and prices are saved in this browser only.</p>
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
      {d?.note && <p className="text-xs text-muted">{d.note}</p>}
    </div>
  );
}

export function MarketCard({ m }: { m: MarketMeta }) {
  return (
    <Card className={m.validated ? "border-accent/30" : "border-warn/40"}>
      <CardBody className="flex flex-wrap items-start gap-x-8 gap-y-3">
        <div className="min-w-[220px] flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-lg font-semibold">{m.label}</span>
            {m.validated ? <Badge tone="accent">Validated</Badge> : <Badge tone="warn">Research projection</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            {m.validated ? "Passed every check on games the model never saw, so over/under chances are shown."
              : m.tested ? `Over/under chances are hidden until it passes. Not yet: ${(m.failed_checks ?? []).map((c) => CHECK_LABELS[c] ?? c).join(", ")}.`
                : "Not tested yet."}
          </p>
        </div>
        {m.tested && (
          <div className="flex flex-wrap gap-6 text-sm">
            <div><div className="label">Typical miss</div><div className="font-semibold">{num(m.mae_median, 1)} <span className="text-xs font-normal text-muted">vs {num(m.baseline_mae_median, 1)} player avg</span></div></div>
            <div><div className="label">10–90% range held</div><div className="font-semibold">{pct(m.coverage_10_90, 0)} <span className="text-xs font-normal text-muted">expected {pct(m.coverage_expected, 0)}</span></div></div>
            <div><div className="label">Strong leans correct</div><div className="font-semibold">{m.lean_hit_rate != null ? pct(m.lean_hit_rate, 0) : "—"} <span className="text-xs font-normal text-muted">{m.lean_n} picks ≥60%, at each player's usual line</span></div></div>
            <div><div className="label">Tested on</div><div className="font-semibold">{m.test_rows?.toLocaleString()} <span className="text-xs font-normal text-muted">games, {m.test_weeks} weeks</span></div></div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
