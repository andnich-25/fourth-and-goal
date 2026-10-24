import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Trophy } from "lucide-react";
import { STATIC } from "@/lib/api";
import { chicago, cn, pct } from "@/lib/format";
import { SPORT_LABEL, type LabBoard, type LabPick, type LabRecord, type Sport } from "@/lib/lab";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, LoadingBlock, Notice } from "@/components/ui";
import { WriteUp } from "@/components/WriteUp";

const URL = STATIC ? `${import.meta.env.BASE_URL}data/lab/board.json` : "/api/lab/board.json";

async function getBoard(): Promise<LabBoard> {
  const r = await fetch(URL);
  if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error("The Lab's picks are built on each site refresh and are not published yet.");
  return r.json();
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "short" });
const price = (p: number | null) => (p == null ? "" : p > 0 ? `+${p}` : String(p));

/** The week's best plays across every sport, ranked 1 to 10, each with its full write-up. */
export default function LabPicks() {
  const q = useQuery({ queryKey: ["lab-board"], queryFn: getBoard, staleTime: 5 * 60_000 });
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const b = q.data;
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="space-y-5">
      <PageTitle kicker={b ? `NFL · College football · NBA · updated ${chicago(b.generated_at)}` : "All sports"} title="The Lab's top 10" />
      <p className="-mt-3 max-w-3xl text-sm text-muted">
        The plays most likely to win across every sport, ranked by their chance to hit: #1 is the surest. Only picks with a 70%+ chance from 5,000-game
        simulations and tested tiers make it. Tap a pick for the full write-up.
      </p>
      {q.isLoading && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {q.isError && <Notice title="Not published yet">{(q.error as Error).message}</Notice>}
      {b?.note && <Notice tone="info">{b.note}</Notice>}
      {b && !b.board.length && <Notice title="No picks right now">Nothing on the board reaches a 70% chance from a proven tier. Picks appear as lines are posted and each sport refreshes.</Notice>}

      {!!b?.board.length && (
        <Card className="overflow-hidden">
          <ol className="divide-y divide-line/60">
            {b.board.map((p) => <PickRow key={p.id} p={p} open={open.has(p.id)} onToggle={() => toggle(p.id)} />)}
          </ol>
        </Card>
      )}

      {b && <RecordCard b={b} />}

      <Card><CardBody className="space-y-1.5 text-xs text-muted">
        <p><b className="text-fg">How the list is made.</b> Each sport offers only the picks it already features: NFL and NBA props from confidence tiers that hit 50%+ on unseen games,
          and college bets rated 7+. Of those, only picks with a 70%+ chance to hit make the list (simulated, then calibrated against how similar picks really did), ranked by that
          chance, highest first. Ties go to a real sportsbook line, then to the tier's tested record. One pick per game and per player. Most college bets land near 55%, so
          they rarely make it. Even a 90% pick loses 1 time in 10: the "tested" figure on each pick is how often its tier actually hit on games the models never saw.</p>
        <p>The list refreshes with each sport's data (latest box scores, injury reports and lines). A pick on the list when its game starts is frozen exactly as shown and graded after the final.
          Research, not betting advice. No pick is guaranteed.</p>
      </CardBody></Card>
    </div>
  );
}

function PickRow({ p, open, onToggle }: { p: LabPick; open: boolean; onToggle: () => void }) {
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-raised/50 sm:items-center sm:px-5">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-display text-lg font-bold",
          p.rank === 1 ? "bg-accent text-accent-fg" : "bg-accent/10 text-accent")}>{p.rank}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <SportBadge sport={p.sport} />
            <span className="font-semibold leading-snug">{p.bet}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted">{p.matchup} · {when(p.kickoff)}{p.line_source === "usual" ? " · usual line, check your book" : ""}</div>
          <div className="mt-1 hidden text-sm text-muted sm:block">{p.headline}</div>
        </div>
        <div className="shrink-0 text-right">
          <div><span className="font-display text-xl font-bold">{pct(p.chance, 0)}</span> <span className="text-xs text-muted">to hit</span></div>
          {p.price != null && <div className="text-xs text-muted">{price(p.price)}{p.book ? ` ${p.book}` : ""}</div>}
          {p.result ? <ResultBadge p={p} /> : p.tier && <div className="text-[11px] text-muted">{p.tier}{p.tier_rate != null ? ` · ${pct(p.tier_rate, 0)} tested` : ""}</div>}
        </div>
        <ChevronDown className={cn("mt-2 h-4 w-4 shrink-0 text-muted transition-transform sm:mt-0", open && "rotate-180")} aria-hidden />
      </button>
      <div className="-mt-1 px-4 pb-3 pl-16 text-sm text-muted sm:hidden">{p.headline}</div>
      {open && (
        <div className="border-t border-line/60 bg-bg/30">
          <WriteUp sections={p.sections} />
          <div className="px-4 py-2.5 text-xs sm:px-5"><Link to={p.link} className="text-accent hover:underline">Open in {SPORT_LABEL[p.sport]}</Link></div>
        </div>
      )}
    </li>
  );
}

const SPORT_TONE: Record<Sport, "accent" | "info" | "warn"> = { nfl: "accent", cfb: "info", nba: "warn" };
function SportBadge({ sport }: { sport: Sport }) {
  return <Badge tone={SPORT_TONE[sport]}>{SPORT_LABEL[sport]}</Badge>;
}

function ResultBadge({ p }: { p: LabPick }) {
  const tone = p.result === "won" ? "ok" : p.result === "lost" ? "danger" : "neutral";
  const label = { won: "Won", lost: "Lost", push: "Push", void: "Void" }[p.result!];
  return <Badge tone={tone} title={p.actual}>{label}</Badge>;
}

const recText = (r: LabRecord) => (r.n ? `${r.won}-${r.lost}${r.push ? `-${r.push}` : ""}` : "–");

/** Every pick that was on the list at kickoff, graded after the final. */
function RecordCard({ b }: { b: LabBoard }) {
  const r = b.record;
  const pending = b.recent.filter((p) => !p.result).length;
  return (
    <Card>
      <CardHeader title="How the list has done" icon={<Trophy className="h-4 w-4 text-accent" />}
        subtitle={r.since ? `Every pick that was on the list when its game started, since ${new Date(r.since).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Picks are frozen at kickoff and graded after the final."} />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div><div className="label">Record</div><div className="font-display text-xl font-bold">{recText(r)}</div></div>
          <div><div className="label">Hit rate</div><div className="font-display text-xl font-bold">{r.rate == null ? "–" : pct(r.rate, 0)}</div></div>
          {(["nfl", "cfb", "nba"] as Sport[]).map((s) => (
            <div key={s}><div className="label">{SPORT_LABEL[s]}</div><div className="font-semibold">{recText(r.by_sport[s])}</div></div>
          ))}
        </div>
        {!b.recent.length && <p className="text-sm text-muted">The record starts with the first games played after the list goes live.</p>}
        {pending > 0 && <p className="text-xs text-muted">{pending} frozen {pending === 1 ? "pick is" : "picks are"} waiting on a final.</p>}
      </CardBody>
      {!!b.recent.length && (
        <ul className="divide-y divide-line/60 border-t border-line">
          {b.recent.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-2 text-sm sm:px-5">
              <span className="w-6 shrink-0 text-center text-xs font-bold text-muted">#{p.rank}</span>
              <SportBadge sport={p.sport} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.bet}</div>
                <div className="truncate text-xs text-muted">{p.matchup} · {when(p.kickoff)}{p.actual ? ` · ${p.actual}` : ""}</div>
              </div>
              <span className="text-xs text-muted">{pct(p.chance, 0)}</span>
              {p.result ? <ResultBadge p={p} /> : <Badge>Pending</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
