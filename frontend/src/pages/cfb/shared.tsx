import { Link } from "react-router-dom";
import { cn, pct } from "@/lib/format";
import { MARKET_LABEL, bookName, fmtPrice, pickText, ranked, tierOf, type Backtest, type CfbGame, type Lean } from "@/lib/cfb";
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
        <div className="text-sm"><b className="text-base">{m.score.toFixed(1)}</b><span className="text-muted">/10</span></div>
        <div className="flex items-center justify-end gap-1">
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
