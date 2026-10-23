import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MessageCircleQuestion } from "lucide-react";
import { pct } from "@/lib/format";
import { marketLabel, nbaTier, score10, useNba, type MarketReport, type NbaConfidence, type NbaCorrelation, type NbaDue, type NbaRecord, type Slate } from "@/lib/nba";
import { answer, SUGGESTIONS } from "@/lib/nbaAsk";
import { toAmerican } from "@/lib/sim";
import { PageTitle } from "@/components/Layout";
import { Button, Card, CardBody, CardHeader, Input, LoadingBlock } from "@/components/ui";
import { TierBadge } from "@/components/shared";
import { WriteUp } from "@/components/WriteUp";
import { AiCard, AiKeyLink, AiToggle, KeyPanel, useAiAnswer, useAiMode } from "@/components/AiAsk";
import { Headshot, NotPublished } from "./shared";

export default function NbaAsk() {
  const [sp, setSp] = useSearchParams();
  const asked = sp.get("q") ?? "";
  const [q, setQ] = React.useState(asked);
  const slate = useNba<Slate>("slate.json");
  const cor = useNba<NbaCorrelation>("correlation.json");
  const conf = useNba<NbaConfidence>("confidence.json");
  const markets = useNba<{ markets: MarketReport[] }>("markets.json");
  const record = useNba<NbaRecord>("record.json");
  const due = useNba<NbaDue>("due.json");
  const ask = (text: string) => { setQ(text); setSp({ q: text }, { replace: true }); };
  const ai = useAiMode();
  const a = React.useMemo(() => (asked && slate.data
    ? answer(asked, slate.data, cor.data?.buckets, !!cor.data?.use_correlation, { conf: conf.data, markets: markets.data, record: record.data, due: due.data })
    : null), [asked, slate.data, cor.data, conf.data, markets.data, record.data, due.data]);
  const run = React.useMemo(() => (slate.data ? (text: string, onStatus: (s: string) => void) => import("@/lib/nbaAskAi")
    .then((m) => m.askNbaAi(ai.key, { slate: slate.data!, cor: cor.data, ctx: { conf: conf.data, markets: markets.data, record: record.data, due: due.data } }, text, [], onStatus)) : null),
  [slate.data, cor.data, conf.data, markets.data, record.data, due.data, ai.key]);
  const aiAns = useAiAnswer(asked, ai.on, run);
  if (slate.isError) return <NotPublished error={slate.error} />;
  return (
    <div className="space-y-5">
      <PageTitle kicker="NBA" title="Ask" />
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) ask(q.trim()); }} className="flex gap-2">
        <div className="relative flex-1">
          <MessageCircleQuestion className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about tonight's props" className="pl-9" aria-label="Question" />
        </div>
        <AiToggle ai={ai} />
        <Button type="submit" variant="primary">Ask</Button>
      </form>
      <div className="-mt-3 text-right"><AiKeyLink ai={ai} /></div>
      {ai.showKey && <KeyPanel keyValue={ai.key} onSave={ai.save} />}
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">{s}</button>)}
      </div>
      {!slate.data && <Card><LoadingBlock rows={4} className="p-5" /></Card>}
      {aiAns && <AiCard text={aiAns.text} status={aiAns.status} error={aiAns.error} />}
      {a && (!aiAns || aiAns.error) && (
        <Card>
          <CardHeader title={a.title} subtitle={a.text} />
          {!!a.sections?.length && <WriteUp sections={a.sections} />}
          {!!a.bullets?.length && (
            <CardBody className="border-b border-line text-sm">
              <ul className="list-disc space-y-1 pl-5 text-muted">{a.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
            </CardBody>
          )}
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
            {!a.items.length && !a.text && !a.bullets?.length && !a.sections?.length && <p className="p-4 text-sm text-muted">Nothing matches. Try one of the suggestions.</p>}
          </div>
          {!!a.suggestions?.length && (
            <CardBody className="flex flex-wrap gap-2 border-t border-line">
              <span className="text-xs text-muted">Try:</span>
              {a.suggestions.map((s) => <button key={s} onClick={() => ask(s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">{s}</button>)}
            </CardBody>
          )}
        </Card>
      )}
    </div>
  );
}
