import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, CircleDollarSign, Database, Hourglass, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn, num, pct } from "@/lib/format";
import { useLinkSuffix } from "@/lib/state";
import type { Reason } from "@/lib/types";
import type { Due, Edge } from "@/lib/signals";
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

/** Confidence tier with its real track record, e.g. "Strong · 58% hit in 1,204 past picks". */
export function TierBadge({ tier, compact = false }: { tier: import("@/lib/confidence").Tier | null; compact?: boolean }) {
  if (!tier) return null;
  const tone = tier.tier === "Strong" ? "ok" : tier.tier === "Solid" ? "accent" : tier.tier === "Lean" ? "neutral" : "warn";
  const record = tier.rate != null ? `${pct(tier.rate, 0)} hit in ${tier.n.toLocaleString()} past picks` : "no past picks";
  return (
    <Badge tone={tone} title={`Past walk-forward picks in the ${tier.tier} band (${pct(tier.lo, 0)}–${pct(tier.hi, 0)}): ${record}`}>
      {tier.tier}{!compact && <span className="font-normal opacity-80"> · {record}</span>}
    </Badge>
  );
}

/** Symbols next to a player's name: $ = Edge (beats the best book price), hourglass = Due (fewer TDs than his chances earned). */
export function SignalIcons({ edge, due, className }: { edge?: Edge | null; due?: Due | null; className?: string }) {
  if (!edge && !due) return null;
  const price = (p: number) => (p > 0 ? `+${p}` : String(p));
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5 align-middle", className)}>
      {edge && <span role="img" aria-label="Edge" title={`Edge: our ${pct(edge.chance, 0)} vs ${pct(edge.implied, 0)} implied by ${price(edge.price)} (${edge.book}), +${Math.round(edge.edge * 100)} pts`}>
        <CircleDollarSign className="h-3.5 w-3.5 text-accent" /></span>}
      {due && <span role="img" aria-label="Due" title={`Due: ${due.actual} TD${due.actual === 1 ? "" : "s"} on ${num(due.expected, 1)} expected from his opportunities in ${due.games} games`}>
        <Hourglass className="h-3.5 w-3.5 text-warn" /></span>}
    </span>
  );
}
