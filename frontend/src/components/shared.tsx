import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Database, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn, num, pct } from "@/lib/format";
import { useLinkSuffix } from "@/lib/state";
import type { Reason } from "@/lib/types";
import { Badge, Button, EmptyState } from "./ui";

/** Probability when validated; otherwise the research score with an explicit "not a probability" label. */
export function Estimate({ p, score, calibrated, size = "md" }: { p: number | null; score: number | null; calibrated: boolean; size?: "md" | "lg" }) {
  if (calibrated && p != null) {
    return (
      <div className="leading-none" title="Validated P(1+ rushing or receiving TD) from the promoted walk-forward model">
        <span className={cn("num font-display font-semibold", size === "lg" ? "text-3xl" : "text-lg")}>{pct(p, 0)}</span>
        <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted">P(anytime TD)</div>
      </div>
    );
  }
  return (
    <div className="leading-none" title="Research score = percentile rank among eligible players. It is not a probability.">
      <span className={cn("num font-display font-semibold", size === "lg" ? "text-3xl" : "text-lg")}>{num(score, 0)}</span>
      <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted">Research score</div>
    </div>
  );
}

export function ReasonList({ reasons, limit }: { reasons: Reason[]; limit?: number }) {
  const list = limit ? reasons.slice(0, limit) : reasons;
  return (
    <ul className="space-y-1.5">
      {list.map((r, i) => {
        const Icon = r.sign > 0 ? TrendingUp : r.sign < 0 ? TrendingDown : Minus;
        return (
          <li key={i} className="flex gap-2 text-[13px] leading-snug">
            <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", r.sign > 0 ? "text-accent" : r.sign < 0 ? "text-danger" : "text-muted")}
              aria-label={r.sign > 0 ? "supports" : r.sign < 0 ? "weakens" : "context"} />
            <span className="text-fg/90">{r.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function Flags({ flags, className }: { flags: string[]; className?: string }) {
  if (!flags.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {flags.map((f) => (
        <Badge key={f} tone={/Out|Doubtful/.test(f) ? "danger" : /Questionable|not yet published|Missed|New team/.test(f) ? "warn" : "neutral"}>
          <AlertCircle className="h-3 w-3" aria-hidden />
          {f}
        </Badge>
      ))}
    </div>
  );
}

export function ModelBadge({ version, calibrated }: { version?: string | null; calibrated: boolean }) {
  return calibrated ? (
    <Badge tone="accent" title="Passed the walk-forward promotion gate on unseen weeks">
      <CheckCircle2 className="h-3 w-3" aria-hidden /> Validated · {version}
    </Badge>
  ) : (
    <Badge tone="info" title="No model has passed the promotion gate; probabilities hidden">Research ranks only{version ? ` · ${version}` : ""}</Badge>
  );
}

export function ConfidenceBadge({ c }: { c: string | null }) {
  if (!c) return null;
  return <Badge tone={c === "High" ? "ok" : c === "Medium" ? "neutral" : "warn"} title="Data confidence: sample size, team continuity and snap data">{c}</Badge>;
}

export function NoDataState({ reason }: { reason?: string | null }) {
  const suffix = useLinkSuffix();
  return (
    <EmptyState
      icon={<Database className="h-5 w-5" />}
      title="No league-wide data for this view yet"
      action={<Link to={`/data${suffix}`}><Button variant="primary">Open Data &amp; Sync</Button></Link>}
    >
      {reason ?? "Import the nine nflverse CSV files (2023–2026 play-by-play and weekly stats, plus the 2026 weekly roster)."}{" "}
      Nothing is estimated or filled in until real files are loaded.
    </EmptyState>
  );
}

export function Outcome({ outcome, participated }: { outcome: number | null; participated: number | null }) {
  if (outcome == null && participated == null) return <span className="text-muted">—</span>;
  if (participated === 0) return <Badge tone="neutral">Did not play</Badge>;
  return outcome ? <Badge tone="accent">TD</Badge> : <Badge tone="neutral">No TD</Badge>;
}
