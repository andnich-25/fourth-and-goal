import { CircleDollarSign, Hourglass } from "lucide-react";
import { cn, num, pct } from "@/lib/format";
import { fmtPrice, bookName, score10, type NbaEdge } from "@/lib/nba";
import { Card, EmptyState } from "@/components/ui";

/** Under and over scores out of 10 (they add to 10); the bigger one is the lean. */
export function ScoreSplit({ over }: { over: number }) {
  const under = 1 - over;
  const lean = under > over ? "under" : "over";
  return (
    <div className="flex min-w-[140px] items-center gap-2" title={`Under ${score10(under)} / Over ${score10(over)} out of 10`}>
      <span className={cn("w-8 text-right tabular-nums", lean === "under" ? "font-bold text-fg" : "text-muted")}>{score10(under)}</span>
      <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-raised" aria-hidden>
        <div className={cn("h-full", lean === "under" ? "bg-accent" : "bg-line")} style={{ width: `${under * 100}%` }} />
        <div className={cn("h-full", lean === "over" ? "bg-accent" : "bg-line")} style={{ width: `${over * 100}%` }} />
      </div>
      <span className={cn("w-8 tabular-nums", lean === "over" ? "font-bold text-fg" : "text-muted")}>{score10(over)}</span>
    </div>
  );
}

/** $ = Edge (our chance beats the best book price by 3+ points), hourglass = Due (under his projection 4 games running). */
export function NbaSignals({ edge, due, className }: { edge?: NbaEdge | null; due?: boolean; className?: string }) {
  if (!edge && !due) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5 align-middle", className)}>
      {edge && <span role="img" aria-label="Edge" title={`Edge: our chance beats ${pct(edge.implied, 0)} implied by ${fmtPrice(edge.price)} at ${bookName(edge.book)} by ${Math.round(edge.edge * 100)} pts`}>
        <CircleDollarSign className="h-3.5 w-3.5 text-accent" /></span>}
      {due && <span role="img" aria-label="Due" title="Due: finished under his projection in each of his last 4 games while playing 20+ minutes">
        <Hourglass className="h-3.5 w-3.5 text-warn" /></span>}
    </span>
  );
}

export function Headshot({ src, name, size = 28 }: { src?: string; name: string; size?: number }) {
  if (!src) return null;
  return <img src={src} alt="" aria-hidden width={size} height={size} loading="lazy" className="shrink-0 rounded-full bg-raised object-cover"
    style={{ width: size, height: size }} title={name} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />;
}

export function NotPublished({ error }: { error: unknown }) {
  return (
    <Card>
      <EmptyState title="NBA numbers are not published yet">
        {error instanceof Error ? error.message : "Try again shortly."} The NBA models run every morning before tip-off.
      </EmptyState>
    </Card>
  );
}

export const minutes = (v: number | null | undefined) => num(v, 0);
