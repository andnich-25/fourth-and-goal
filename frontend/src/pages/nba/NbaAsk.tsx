import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MessageCircleQuestion } from "lucide-react";
import { pct } from "@/lib/format";
import { marketLabel, nbaTier, score10, useNba, type NbaConfidence, type NbaCorrelation, type Slate } from "@/lib/nba";
import { answer, SUGGESTIONS } from "@/lib/nbaAsk";
import { toAmerican } from "@/lib/sim";
import { PageTitle } from "@/components/Layout";
import { Button, Card, CardBody, CardHeader, Input, LoadingBlock } from "@/components/ui";
import { TierBadge } from "@/components/shared";
import { Headshot, NotPublished } from "./shared";

export default function NbaAsk() {
  const [sp, setSp] = useSearchParams();
  const asked = sp.get("q") ?? "";
  const [q, setQ] = React.useState(asked);
  const slate = useNba<Slate>("slate.json");
  const cor = useNba<NbaCorrelation>("correlation.json");
  const conf = useNba<NbaConfidence>("confidence.json");
  const ask = (text: string) => { setQ(text); setSp({ q: text }, { replace: true }); };
  const a = React.useMemo(() => (asked && slate.data ? answer(asked, slate.data, cor.data?.buckets, !!cor.data?.use_correlation) : null), [asked, slate.data, cor.data]);
  if (slate.isError) return <NotPublished error={slate.error} />;
  return (
    <div className="space-y-5">
      <PageTitle kicker="NBA" title="Ask" />
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) ask(q.trim()); }} className="flex gap-2">
        <div className="relative flex-1">
          <MessageCircleQuestion className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about tonight's props" className="pl-9" aria-label="Question" />
        </div>
        <Button type="submit" variant="primary">Ask</Button>
      </form>
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">{s}</button>)}
      </div>
      {!slate.data && <Card><LoadingBlock rows={4} className="p-5" /></Card>}
      {a && (
        <Card>
          <CardHeader title={a.title} subtitle={a.text} />
          {a.parlay && (
            <CardBody className="border-b border-line text-sm">
              Chance all hit <b className="text-lg">{pct(a.parlay.joint, 1)}</b> (fair odds {toAmerican(1 / Math.max(a.parlay.joint, 1e-6))}) from {a.parlay.draws.toLocaleString()} simulated games; multiplying gives {pct(a.parlay.independent, 1)}.
              {" "}<Link to="/nba/builder" className="text-accent hover:underline">Open the parlay builder</Link>
            </CardBody>
          )}
          <div className="divide-y divide-line/60">
            {a.items.map((x) => (
              <Link key={`${x.row.player_id}-${x.row.market}-${x.line}`} to={`/nba/players/${x.row.player_id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised/50">
                <Headshot src={x.row.headshot} name={x.row.player_name} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{x.row.player_name}</div>
                  <div className="text-xs text-muted">{x.row.team} {x.row.home ? "vs" : "@"} {x.row.opp}{x.note ? ` · ${x.note}` : ""}</div>
                </div>
                <div className="text-right text-sm">
                  <div className="font-semibold">{x.side === "over" ? "Over" : "Under"} {x.line} {marketLabel(x.row.market)}</div>
                  <div className="flex items-center justify-end gap-1.5 text-xs text-muted"><b className="text-fg">{score10(x.p)}</b>/10<TierBadge tier={nbaTier(conf.data, x.p)} compact /></div>
                </div>
              </Link>
            ))}
            {!a.items.length && !a.text && <p className="p-4 text-sm text-muted">Nothing matches. Try one of the suggestions.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
