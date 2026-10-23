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
export function LeanRow({ m, bt, to, sub, className, simple = false }: { m: Lean; bt?: Backtest; to?: string; sub?: React.ReactNode; className?: string; simple?: boolean }) {
  const tier = tierOf(bt?.markets[m.market], m.tier);
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{pickText(m)}</div>
        <div className="text-xs text-muted">
          {MARKET_LABEL[m.market]}{m.market === "team_total" && !m.line_posted ? " (implied line)" : ""}
          {!simple && m.best?.book ? ` · best ${fmtPrice(m.best.price)} at ${bookName(m.best.book)}` : ""}
          {!simple && m.market === "moneyline" && m.ev != null ? ` · ${m.ev >= 0 ? "+" : ""}${(m.ev * 100).toFixed(1)}¢ per $1` : ""}
          {sub ? <> · {sub}</> : null}
        </div>
      </div>
      <div className="text-right">
        <RatingMeter score={m.score} p={m.p} fair={m.fair_p} ev={m.ev} proven={m.proven} />
        {!simple && (
          <div className="mt-1 flex items-center justify-end gap-1">
            {m.proven ? <Badge tone="ok" title="This tier beat the -110 break-even (52.4%) on games the model never saw">Proven</Badge> : null}
            <TierBadge tier={tier} compact />
          </div>
        )}
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
  { market: "spread", label: "Spread" }, { market: "total", label: "Over/under" }, { market: "moneyline", label: "Moneyline" }];

/** What the 5,000 simulations say for a market, in one short line. */
function simLine(g: CfbGame, market: "spread" | "total" | "moneyline", m?: Lean): string {
  const s = g.model;
  if (market === "spread") return s.margin >= 0 ? `Sims: ${g.home} by ${s.margin.toFixed(1)}` : `Sims: ${g.away} by ${(-s.margin).toFixed(1)}`;
  if (market === "total") return `Sims: ${s.total.toFixed(1)} total points`;
  const p = m ? (m.side === "home" ? s.home_win : 1 - s.home_win) : Math.max(s.home_win, 1 - s.home_win);
  return `Sims: ${m?.team ?? (s.home_win >= 0.5 ? g.home : g.away)} wins ${pct(p, 0)}`;
}

/** One matchup: the teams and the simulated score on top, then three boxes (spread, total, moneyline), each with the
 *  simulation's pick and its rating out of 10. Prices and the details live on the game page. */
export function MatchupRow({ g }: { g: CfbGame }) {
  const fav = g.model.margin >= 0 ? g.home : g.away;
  return (
    <Link to={`/cfb/game/${g.game_id}`} className="block space-y-2.5 px-4 py-3.5 text-sm hover:bg-raised/40">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div className="font-semibold"><Matchup g={g} /></div>
        <div className="text-xs text-muted">{kick(g.date)}{g.tv ? ` · ${g.tv}` : ""}</div>
      </div>
      <div className="text-xs text-muted">
        Simulated score: <span className="text-fg">{g.away} {g.model.away.toFixed(0)}, {g.home} {g.model.home.toFixed(0)}</span>
        {" "}· {fav} wins {pct(Math.max(g.model.home_win, 1 - g.model.home_win), 0)} of sims
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {MATCHUP_CELLS.map(({ market, label }) => {
          const m = g.markets.find((x) => x.market === market);
          return (
            <div key={market}
              className={cn("flex items-center justify-between gap-2 rounded-lg border px-3 py-2 sm:block", m && m.score >= 7 ? "border-ok/60 bg-ok/5" : "border-line bg-raised/30")}>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">{label}
                  {m && m.score >= 7 && <span className="rounded bg-ok/15 px-1 text-[10px] text-ok">Pick</span>}</div>
                <div className="truncate text-[15px] font-semibold">
                  {!m ? <span className="text-sm font-normal text-muted">No line yet</span>
                    : market === "moneyline" ? `${m.team} ${fmtPrice(m.price)}` : market === "spread" ? `${m.team} ${fmtLine(m.line!)}` : `${m.side === "over" ? "Over" : "Under"} ${m.line}`}
                </div>
                {m && <div className="text-xs text-muted sm:truncate">{simLine(g, market, m)}</div>}
              </div>
              {m && <div className="shrink-0 sm:mt-1.5"><RatingMeter size="sm" score={m.score} p={m.p} fair={m.fair_p} ev={m.ev} proven={m.proven} /></div>}
            </div>
          );
        })}
      </div>
    </Link>
  );
}

/** The one-line key to the ratings, shown above lists of picks. */
export function RatingKey({ className }: { className?: string }) {
  const chip = (tone: string) => <span className={cn("inline-block h-2.5 w-2.5 rounded-[2px]", tone)} />;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted", className)}>
      <span className="font-medium text-fg">Rating out of 10</span>
      <span className="inline-flex items-center gap-1.5">{chip("bg-ok")} 7+ pick: beat the books in testing</span>
      <span className="inline-flex items-center gap-1.5">{chip("bg-warn")} 5 to 7: lean</span>
      <span className="inline-flex items-center gap-1.5">{chip("bg-muted/50")} under 5: pass</span>
    </div>
  );
}
