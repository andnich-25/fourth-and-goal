import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Search } from "lucide-react";
import { api } from "@/lib/api";
import { americanToProb, cn, num, pct } from "@/lib/format";
import { MARKET_GROUPS, pOver, type PropDist } from "@/lib/props";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, ErrorState, Input, LoadingBlock, Notice, PosBadge, Select, TableWrap, Td, TeamBadge, Th } from "@/components/ui";
import { Flags, NoDataState } from "@/components/shared";

export type MarketMeta = {
  market: string; label: string; positions: string[]; kind: string; validated: boolean; model: string | null; tested: boolean;
  test_rows?: number; test_weeks?: number; crps_gain_pct?: number; mae_median?: number; baseline_mae_median?: number;
  coverage_10_90?: number; coverage_expected?: number; over_ece?: number; lean_n?: number; lean_hit_rate?: number | null; failed_checks?: string[];
};
type PropRow = {
  player_id: string; player_name: string; team: string; opponent: string; position: string; game_id: string; eligible: number;
  exclusion: string | null; flags: string[]; model: string; calibrated: number; mean: number; median: number; q10: number; q90: number;
  dist: PropDist | null; evidence: Record<string, number | null>; actual: number | null;
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

export default function PropsPage() {
  const { season, week } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const [market, setMarket] = React.useState("receptions");
  const [search, setSearch] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<Lines>(loadLines);
  React.useEffect(() => { try { localStorage.setItem(LINES_KEY, JSON.stringify(lines)); } catch { /* ignore */ } }, [lines]);
  const meta = useQuery({ queryKey: ["props-markets"], queryFn: () => api.get<MarketsResp>("/props/markets") });
  const q = useQuery({ queryKey: ["props", season, week, market], queryFn: () => api.get<PropsResp>("/props", { season, week, market }) });
  const d = q.data;
  const m = d?.market;
  const stat = ({ pass_attempts: "attempts", rush_rec_yards: "rush_rec_yards" } as Record<string, string>)[market] ?? market;
  const rows = (d?.rows ?? []).filter((r) => !search || r.player_name.toLowerCase().includes(search.toLowerCase()));
  const key = (r: PropRow) => `${season}-${week}-${market}-${r.player_id}`;

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
      <Notice tone="info" title="How to use this">
        Type the line you see at your sportsbook (for example 64.5). For validated markets the site shows the chance of going over and under. Add the over odds to compare
        with the book's implied chance. Lines are saved in this browser only. Nothing here is guaranteed.
      </Notice>

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
            <span className="text-sm text-muted">{rows.length} players · {m?.validated ? "validated chances" : "research projections only"}</span>
          </div>
          <TableWrap>
            <table className="w-full">
              <thead><tr>
                <Th>Player</Th><Th>Opp</Th><Th className="text-right" title="Middle of the projected range: half of outcomes above, half below">Projection</Th>
                <Th className="text-right" title="80% of outcomes should land in this range">10–90% range</Th>
                <Th>Your line</Th><Th className="text-right">Over</Th><Th className="text-right">Under</Th>
                <Th title="Optional: American odds for the over">Over odds</Th><Th className="text-right" title="Our over chance minus the book's implied chance (which includes the book's margin)">vs book</Th>
                {d.rows.some((r) => r.actual != null) && <Th className="text-right">Result</Th>}<Th />
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const k = key(r);
                  const ln = lines[k] ?? {};
                  const lineNum = ln.line ? Number(ln.line) : NaN;
                  const over = r.dist && Number.isFinite(lineNum) ? pOver(r.dist, lineNum) : null;
                  const implied = ln.odds ? americanToProb(ln.odds) : null;
                  const edge = over != null && implied != null ? over - implied : null;
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
                        <Td><Input aria-label={`Line for ${r.player_name}`} inputMode="decimal" placeholder={`${Math.floor(r.median) + 0.5}`} value={ln.line ?? ""}
                          onChange={(e) => setLines({ ...lines, [k]: { ...ln, line: e.target.value } })} className="h-8 w-20" /></Td>
                        <Td className="text-right font-semibold">{r.dist ? (over != null ? pct(over, 0) : <span className="text-muted">—</span>) : <span className="text-xs text-muted" title="Not validated">hidden</span>}</Td>
                        <Td className="text-right">{over != null ? pct(1 - over, 0) : <span className="text-muted">—</span>}</Td>
                        <Td><Input aria-label={`Over odds for ${r.player_name}`} placeholder="-110" value={ln.odds ?? ""} disabled={!r.dist}
                          onChange={(e) => setLines({ ...lines, [k]: { ...ln, odds: e.target.value } })} className="h-8 w-20" /></Td>
                        <Td className={cn("text-right", edge != null && (edge > 0 ? "text-accent" : "text-danger"))}>{edge != null ? `${edge > 0 ? "+" : ""}${Math.round(edge * 100)} pts` : <span className="text-muted">—</span>}</Td>
                        {d.rows.some((x) => x.actual != null) && <Td className="text-right">{r.actual != null ? num(r.actual, 0) : "—"}</Td>}
                        <Td><button aria-expanded={open === r.player_id} aria-label="Show evidence" onClick={() => setOpen(open === r.player_id ? null : r.player_id)} className="rounded p-1 text-muted hover:bg-raised">
                          <ChevronDown className={cn("h-4 w-4 transition", open === r.player_id && "rotate-180")} /></button></Td>
                      </tr>
                      {open === r.player_id && (
                        <tr className="border-b border-line bg-raised/30"><td colSpan={11} className="px-4 py-3">
                          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
                            {Object.entries(r.evidence).map(([ek, v]) => (
                              <div key={ek} className="flex justify-between gap-3"><span className="text-muted">{evidenceLabel(ek, stat, m?.label ?? "")}</span><span className="font-medium">{evidenceValue(ek, v)}</span></div>
                            ))}
                          </div>
                          <Flags flags={r.flags} className="mt-2" />
                          <p className="mt-2 text-xs text-muted">All numbers come from games before this week. Model {r.model}; mean projection {num(r.mean, 1)}.</p>
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
