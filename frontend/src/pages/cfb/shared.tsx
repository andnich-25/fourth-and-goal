import { Link } from "react-router-dom";
import { cn, pct } from "@/lib/format";
import { MARKET_LABEL, bookName, fmtLine, fmtPrice, kick, pickText, ranked, tierOf, type Backtest, type CfbGame, type Lean } from "@/lib/cfb";
import { Badge, Card, EmptyState } from "@/components/ui";
import { TierBadge } from "@/components/shared";

export function NotPublished({ error }: { error: unknown }) {
  return (
    <Card>
      <EmptyState title="College football numbers are not published yet">
        {error instanceof Error ? error.message : "Try again shortly."} The college football models run every morning.
      </EmptyState>
    </Card>
  );
}

export function Matchup({ g, className }: { g: Pick<CfbGame, "home" | "away" | "home_rank" | "away_rank" | "neutral">; className?: string }) {
  return <span className={className}>{ranked(g.away, g.away_rank)} <span className="text-muted">{g.neutral ? "vs" : "at"}</span> {ranked(g.home, g.home_rank)}</span>;
}

/** One lean: the bet, its score out of 10, the backtest tier and whether that tier is proven. */
export function LeanRow({ m, bt, to, sub, className }: { m: Lean; bt?: Backtest; to?: string; sub?: React.ReactNode; className?: string }) {
  const tier = tierOf(bt?.markets[m.market], m.tier);
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{pickText(m)}</div>
        <div className="text-xs text-muted">
          {MARKET_LABEL[m.market]}{m.market === "team_total" && !m.line_posted ? " (implied line)" : ""}
          {m.best?.book ? ` · best ${fmtPrice(m.best.price)} at ${bookName(m.best.book)}` : ""}
          {m.market === "moneyline" && m.ev != null ? ` · ${m.ev >= 0 ? "+" : ""}${(m.ev * 100).toFixed(1)}¢ per $1` : ""}
          {sub ? <> · {sub}</> : null}
        </div>
      </div>
      <div className="text-right">
        <RatingMeter score={m.score} p={m.p} fair={m.fair_p} ev={m.ev} proven={m.proven} />
        <div className="mt-1 flex items-center justify-end gap-1">
          {m.proven ? <Badge tone="ok" title="This tier beat the -110 break-even (52.4%) on games the model never saw">Proven</Badge> : null}
          <TierBadge tier={tier} compact />
        </div>
      </div>
    </>
  );
  const cls = cn("flex items-center gap-3 px-4 py-2.5", to && "hover:bg-raised/50", className);
  return to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function TierLine({ t, money = false }: { t: { tier: string; n: number; rate: number | null; roi?: number | null; recent_rate?: number | null; recent_roi?: number | null; proven: boolean }; money?: boolean }) {
  return (
    <tr className="border-t border-line/60">
      <td className="py-1.5 pr-3 font-medium">{t.tier}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{t.n.toLocaleString()}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{money ? roiText(t.roi) : pct(t.rate, 1)}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-muted">{money ? roiText(t.recent_roi) : pct(t.recent_rate, 1)}</td>
      <td className="py-1.5 text-right">{t.proven ? <Badge tone="ok">Proven</Badge> : <span className="text-xs text-muted">no</span>}</td>
    </tr>
  );
}

export const roiText = (v: number | null | undefined) => (v == null ? "–" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

/** The Lab rating out of 10 as ten blocks: green 7+ (the band that beat the price in testing), amber 5-7, grey under 5. */
export function RatingMeter({ score, p, fair, ev, proven, size = "md" }: { score: number; p?: number; fair?: number; ev?: number; proven?: boolean; size?: "sm" | "md" }) {
  const tone = score >= 7 ? "bg-ok" : score >= 5 ? "bg-warn" : "bg-muted/50";
  const title = [`Lab rating ${score.toFixed(1)} of 10`, p != null ? `simulated chance ${pct(p, 1)}` : "", fair != null ? `calibrated on past results ${pct(fair, 1)}` : "",
    ev != null ? `expected return ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}¢ per $1` : "", proven === false && score >= 6.9 ? "capped below 7: not proven in testing" : ""]
    .filter(Boolean).join(" · ");
  return (
    <div className="inline-flex items-center gap-2" title={title} aria-label={title}>
      <div className={cn("flex gap-[2px]", size === "sm" ? "h-2" : "h-2.5")}>
        {Array.from({ length: 10 }, (_, i) => {
          const fill = Math.max(0, Math.min(1, score - i));
          return (
            <span key={i} className={cn("relative overflow-hidden rounded-[2px] bg-line", size === "sm" ? "w-1.5" : "w-2")}>
              <span className={cn("absolute inset-y-0 left-0", tone)} style={{ width: `${fill * 100}%` }} />
            </span>
          );
        })}
      </div>
      <span className="text-sm tabular-nums"><b className={size === "sm" ? "" : "text-base"}>{score.toFixed(1)}</b><span className="text-muted">/10</span></span>
    </div>
  );
}

export const MATCHUP_CELLS: { market: "spread" | "total" | "moneyline"; label: string }[] = [
  { market: "spread", label: "Spread" }, { market: "total", label: "Total points" }, { market: "moneyline", label: "Moneyline" }];

/** What the 5,000 simulations say for a market, in one short line. */
function simLine(g: CfbGame, market: "spread" | "total" | "moneyline"): string {
  const m = g.model;
  if (market === "spread") return m.margin >= 0 ? `sims: ${g.home} by ${m.margin.toFixed(1)}` : `sims: ${g.away} by ${(-m.margin).toFixed(1)}`;
  if (market === "total") return `sims: ${m.total.toFixed(1)} points`;
  return `sims: ${m.home_win >= 0.5 ? g.home : g.away} wins ${pct(Math.max(m.home_win, 1 - m.home_win), 0)}`;
}

/** One matchup: the two teams and model score, then the sim's spread, total and moneyline picks, each rated out of 10. */
export function MatchupRow({ g }: { g: CfbGame }) {
  return (
    <Link to={`/cfb/game/${g.game_id}`} className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-sm hover:bg-raised/50 md:grid-cols-[minmax(0,1.2fr)_repeat(3,minmax(0,1fr))] md:items-center">
      <div className="min-w-0">
        <div className="font-medium">{ranked(g.away, g.away_rank)} <span className="tabular-nums text-muted">{g.model.away.toFixed(0)}</span></div>
        <div className="font-medium">{g.neutral ? "vs " : "at "}{ranked(g.home, g.home_rank)} <span className="tabular-nums text-muted">{g.model.home.toFixed(0)}</span></div>
        <div className="text-xs text-muted">{kick(g.date)}{g.tv ? ` · ${g.tv}` : ""} · model score{g.featured ? " · " : ""}{g.featured && <span className="text-accent">featured</span>}</div>
      </div>
      <div className="divide-y divide-line/40 rounded-md bg-raised/40 md:contents">
        {MATCHUP_CELLS.map(({ market, label }) => {
          const m = g.markets.find((x) => x.market === market);
          return (
            <div key={market} className="flex min-w-0 items-center justify-between gap-2 px-2.5 py-1.5 md:block md:border-0 md:p-0">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
                {m ? (
                  <>
                    <div className={cn("truncate font-semibold", m.proven && "text-ok")}>
                      {market === "moneyline" ? `${m.team} ${fmtPrice(m.price)}` : market === "spread" ? `${m.team} ${fmtLine(m.line!)}` : `${m.side === "over" ? "Over" : "Under"} ${m.line}`}
                    </div>
                    <div className="truncate text-[11px] text-muted">{simLine(g, market)}{m.best?.book ? ` · ${fmtPrice(m.best.price)} ${bookName(m.best.book)}` : ""}</div>
                  </>
                ) : <div className="text-xs text-muted">no line yet</div>}
              </div>
              {m && <div className="shrink-0 md:mt-1"><RatingMeter size="sm" score={m.score} p={m.p} fair={m.fair_p} ev={m.ev} proven={m.proven} /></div>}
            </div>
          );
        })}
      </div>
    </Link>
  );
}
