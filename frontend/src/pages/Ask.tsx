import * as React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowUp, Bot, KeyRound, Loader2, MessageCircleQuestion, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn, num, pct } from "@/lib/format";
import { useConfidence } from "@/lib/confidence";
import { useFeed } from "@/lib/feed";
import { answer, EXAMPLES, fmtPrice, gameLabel, american, type Answer, type AskData, type Pick, type PropRow } from "@/lib/ask";
import { loadKey, MODEL, saveKey } from "@/lib/aiKey";
import type { AiTurn } from "@/lib/askAi";
import type { Buckets } from "@/lib/sim";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import type { RankingsResponse } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { TierBadge } from "@/components/shared";
import { Badge, Button, Card, CardBody, CardHeader, Input, LoadingBlock, Notice, PosBadge, TeamBadge } from "@/components/ui";

const SLIP_KEY = "fg-parlay-slip-v1";

/** Everything the answer engine reads, loaded from the same endpoints the other pages use. */
export function useAskData(season: number, week: number): { data: AskData | null; loading: boolean } {
  const ranks = useQuery({ queryKey: ["rankings-all", season, week], queryFn: () => api.get<RankingsResponse>("/rankings", { season, week, eligible_only: true, page_size: 2000, sort: "rank", order: "asc" }) });
  const markets = useQuery({ queryKey: ["props-markets"], queryFn: () => api.get<{ markets: { market: string; label: string; validated: boolean }[] }>("/props/markets") });
  const validated = (markets.data?.markets ?? []).filter((m) => m.validated);
  const props = useQueries({ queries: validated.map((m) => ({ queryKey: ["props", season, week, m.market], queryFn: () => api.get<{ rows: PropRow[] }>("/props", { season, week, market: m.market }) })) });
  const model = useQuery({ queryKey: ["parlay-model"], queryFn: () => api.get<{ use_correlation: boolean; buckets: Buckets }>("/parlay/model") });
  const feed = useFeed(season, week);
  const conf = useConfidence();
  const loading = ranks.isLoading || markets.isLoading || props.some((p) => p.isLoading) || model.isLoading;
  const propsKey = props.map((p) => p.dataUpdatedAt).join(",");
  const data = React.useMemo<AskData | null>(() => {
    if (!ranks.data) return null;
    const pm: AskData["props"] = {};
    validated.forEach((m, i) => { const rows = props[i]?.data?.rows; if (rows) pm[m.market] = { label: m.label, rows }; });
    return { season, week, td: ranks.data.calibrated ? ranks.data.rows : [], props: pm, feed, conf: conf.data,
      buckets: model.data?.buckets ?? {}, useCorr: !!model.data?.use_correlation };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranks.data, propsKey, feed, conf.data, model.data, season, week]);
  return { data, loading };
}

type Turn = { id: number; q: string; mode: "built-in" | "ai"; a?: Answer; text?: string; error?: string; status?: string };

export default function AskPage() {
  const { season, week } = useSeasonWeek();
  const { data, loading } = useAskData(season, week);
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = React.useState("");
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [key, setKey] = React.useState(loadKey);
  const [useAi, setUseAi] = React.useState(() => !!loadKey());
  const [showKey, setShowKey] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);
  const nextId = React.useRef(1);

  const ask = React.useCallback(async (question: string) => {
    const text = question.trim();
    if (!text || !data) return;
    setQ("");
    const id = nextId.current++;
    const ai = useAi && !!key;
    setTurns((t) => [...t, { id, q: text, mode: ai ? "ai" : "built-in", a: ai ? undefined : answer(data, text), status: ai ? "Thinking…" : undefined }]);
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
    if (!ai) return;
    const history: AiTurn[] = turns.filter((t) => t.mode === "ai" && t.text).slice(-4).flatMap((t) => [{ role: "user" as const, text: t.q }, { role: "assistant" as const, text: t.text as string }]);
    try {
      const { askAi } = await import("@/lib/askAi"); // the SDK loads only when AI mode is used
      const reply = await askAi(key, data, text, history, (s) => setTurns((all) => all.map((t) => (t.id === id ? { ...t, status: s } : t))));
      setTurns((all) => all.map((t) => (t.id === id ? { ...t, text: reply, status: undefined } : t)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTurns((all) => all.map((t) => (t.id === id ? { ...t, status: undefined, error: /401|auth|api.key/i.test(msg) ? "The API key was not accepted. Check it under AI answers." : msg, a: answer(data, text) } : t)));
    }
  }, [data, useAi, key, turns]);

  // Questions sent from the home page arrive as ?q=
  const incoming = sp.get("q");
  React.useEffect(() => {
    if (!incoming || !data) return;
    const next = new URLSearchParams(sp); next.delete("q"); setSp(next, { replace: true });
    void ask(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, data]);

  return (
    <div className="space-y-5">
      <PageTitle kicker={`${season} · Week ${week}`} title="Ask">
        {turns.length > 0 && <Button size="sm" variant="ghost" onClick={() => setTurns([])}><Trash2 className="h-3.5 w-3.5" />Clear</Button>}
      </PageTitle>

      {!turns.length && (
        <Card>
          <CardBody className="space-y-3">
            <div className="flex items-start gap-3">
              <MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
              <p className="text-sm text-muted">Ask about this week in plain English: touchdown scorers, player props, parlays, value against the books, a team, a game,
                a player, or how accurate the model is. Add filters like a position (WR), a team (Bears) or a day (Thursday). Answers use only the site's validated chances and real sportsbook prices.</p>
            </div>
            <div className="flex flex-wrap gap-2">{EXAMPLES.map((e) => <Chip key={e} onClick={() => void ask(e)} disabled={!data}>{e}</Chip>)}</div>
          </CardBody>
        </Card>
      )}

      {loading && !data && <Card><LoadingBlock rows={4} className="p-5" /></Card>}
      {data && !data.td.length && <Notice tone="warn">The touchdown model has no validated chances for this week, so touchdown answers are unavailable.</Notice>}

      <div className="space-y-5">
        {turns.map((t) => <TurnView key={t.id} t={t} data={data} onAsk={(x) => void ask(x)} season={season} week={week} />)}
        <div ref={endRef} />
      </div>

      <div className="sticky bottom-16 z-20 -mx-4 bg-bg/90 px-4 pb-3 pt-2 backdrop-blur sm:-mx-6 sm:px-6 lg:bottom-0">
        <form onSubmit={(e) => { e.preventDefault(); void ask(q); }} className="flex items-center gap-2 rounded-xl border border-line bg-surface p-2 shadow-lg">
          <Input aria-label="Your question" placeholder={data ? "Ask anything about this week…" : "Loading this week's data…"} value={q} onChange={(e) => setQ(e.target.value)} className="h-10 flex-1 border-0 bg-transparent text-base focus-visible:ring-0" />
          <button type="button" onClick={() => (key ? setUseAi((v) => !v) : setShowKey(true))} title={key ? "Switch between AI and built-in answers" : "Turn on AI answers"}
            className={cn("flex h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium", useAi && key ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised")}>
            <Bot className="h-4 w-4" aria-hidden />{useAi && key ? "AI" : "Built-in"}
          </button>
          <Button type="submit" variant="primary" disabled={!q.trim() || !data} aria-label="Ask"><ArrowUp className="h-4 w-4" /></Button>
        </form>
        <div className="mt-1 text-right"><button className="text-[11px] text-muted underline" onClick={() => setShowKey((v) => !v)}><KeyRound className="mr-1 inline h-3 w-3" />AI answers</button></div>
      </div>

      {showKey && <KeyPanel keyValue={key} onSave={(k) => { saveKey(k); setKey(k); setUseAi(!!k); setShowKey(false); }} />}
    </div>
  );
}

function Chip({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className="rounded-full border border-line bg-bg/40 px-3 py-1.5 text-left text-xs hover:border-accent hover:text-accent disabled:opacity-50">{children}</button>;
}

function TurnView({ t, data, onAsk, season, week }: { t: Turn; data: AskData | null; onAsk: (q: string) => void; season: number; week: number }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-end"><div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent/15 px-4 py-2 text-sm">{t.q}</div></div>
      {t.status && <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t.status}</div>}
      {t.error && <Notice tone="warn">{t.error} Showing the built-in answer instead.</Notice>}
      {t.text && (
        <Card><CardBody className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted"><Bot className="h-3.5 w-3.5" />AI answer from the site's numbers</div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{t.text.replace(/\*\*(.+?)\*\*/g, "$1")}</div>
        </CardBody></Card>
      )}
      {t.a && <AnswerView a={t.a} data={data} onAsk={onAsk} season={season} week={week} />}
    </div>
  );
}

function AnswerView({ a, data, onAsk, season, week }: { a: Answer; data: AskData | null; onAsk: (q: string) => void; season: number; week: number }) {
  const navigate = useNavigate();
  const suffix = useLinkSuffix();
  const all = [...(a.picks ?? []), ...(a.groups?.flatMap((g) => g.picks) ?? [])];
  const toBuilder = () => {
    if (!data) return;
    let store: Record<string, unknown[]> = {};
    try { store = JSON.parse(localStorage.getItem(SLIP_KEY) || "{}"); } catch { /* fresh */ }
    store[`${season}-${week}`] = all.slice(0, 10).map((p) => slipLeg(data, p));
    try { localStorage.setItem(SLIP_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ }
    navigate(`/builder${suffix}`);
  };
  return (
    <Card>
      <CardHeader title={a.title} subtitle={a.summary} />
      {a.parlay && (
        <div className="flex flex-wrap gap-6 border-b border-line px-4 py-3 sm:px-5">
          <div><div className="label">All {a.parlay.legs} hit (simulated)</div><div className="font-display text-2xl font-semibold">{pct(a.parlay.joint, 1)}</div></div>
          {a.parlay.price && <div><div className="label">Best prices multiplied</div><div className="font-display text-2xl font-semibold">{american(a.parlay.price)}</div>
            <div className="text-xs text-muted">implies {pct(1 / a.parlay.price, 1)}</div></div>}
        </div>
      )}
      {a.picks && <PickList picks={a.picks} suffix={suffix} />}
      {a.groups?.map((g) => (
        <div key={g.title}>
          <div className="border-b border-line bg-raised/40 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted sm:px-5">{g.title}</div>
          {g.picks.length ? <PickList picks={g.picks} suffix={suffix} /> : <div className="px-4 py-3 text-sm text-muted sm:px-5">No validated chances.</div>}
        </div>
      ))}
      {a.projections && (
        <ul className="divide-y divide-line">{a.projections.map((p) => (
          <li key={`${p.name}-${p.market}`} className="flex items-center gap-2 px-4 py-2 text-sm sm:px-5">
            <span className="hidden sm:inline-flex"><TeamBadge team={p.team} /></span><PosBadge pos={p.pos} /><span className="min-w-0 flex-1 truncate">{p.name} <span className="text-xs text-muted">{data?.props[p.market]?.label ?? p.market}</span></span>
            <span className="font-semibold">{num(p.median, 1)}</span><span className="text-xs text-muted">{num(p.range[0], 0)}–{num(p.range[1], 0)}</span>
          </li>))}</ul>
      )}
      <CardBody className="space-y-3">
        {a.notes.length > 0 && <ul className="space-y-1 text-xs text-muted">{a.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        <div className="flex flex-wrap gap-2">
          {all.length > 0 && <Button size="sm" variant="outline" onClick={toBuilder}>Open in parlay builder</Button>}
          {a.followups.filter((f) => f !== "Open this in the parlay builder").map((f) => <Chip key={f} onClick={() => onAsk(f)}>{f}</Chip>)}
        </div>
      </CardBody>
    </Card>
  );
}

function PickList({ picks, suffix }: { picks: Pick[]; suffix: string }) {
  return (
    <ul className="divide-y divide-line">
      {picks.map((p) => (
        <li key={p.id + p.side} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="hidden sm:inline-flex"><TeamBadge team={p.team} /></span><PosBadge pos={p.pos} />
              <Link className="truncate text-sm font-medium hover:text-accent" to={`/players/${p.player_id}${suffix}`}>{p.name}</Link>
              <span className="text-xs text-muted">{p.team} · {gameLabel(p.game_id)}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="text-fg">{p.label}</span>
              {p.price != null && <span>{fmtPrice(p.price)} at {p.book}</span>}
              {p.edge != null && p.edge >= 0.03 && <Badge tone="ok">+{Math.round(p.edge * 100)} pts vs book</Badge>}
              {p.note && <Badge tone="warn">{p.note}</Badge>}
            </div>
          </div>
          <div className="text-right">
            <div className="font-display text-lg font-semibold">{pct(p.p, 0)}</div>
            <TierBadge tier={p.tierData ?? null} compact />
          </div>
        </li>
      ))}
    </ul>
  );
}

function slipLeg(d: AskData, p: Pick) {
  const prices: Record<string, string> = {};
  for (const r of d.feed.get(p.market, p.player_id, p.side)) if (p.market === "td" || r.line === p.line) prices[r.book] = fmtPrice(r.price);
  return { id: p.id, market: p.market, player_id: p.player_id, team: p.team, position: p.pos, game_id: p.game_id, p: p.p, side: p.side, name: p.name,
    opponent: p.opp, label: p.market === "td" ? "Anytime TD" : d.props[p.market]?.label ?? p.market, line: p.line, dist: p.dist, recent: p.recent, prices };
}

function KeyPanel({ keyValue, onSave }: { keyValue: string; onSave: (k: string) => void }) {
  const [v, setV] = React.useState(keyValue);
  return (
    <Card>
      <CardHeader icon={<Bot className="h-4 w-4 text-accent" />} title="AI answers (optional)" subtitle="Lets Claude understand any wording. It can only use the site's numbers, through the same functions as the built-in answers." />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">Paste an Anthropic API key (from console.anthropic.com). It is saved only in this browser and sent only to Anthropic. Each question
          costs a few cents on that key (model {MODEL}). Built-in answers stay free and work without a key.</p>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); onSave(v.trim()); }}>
          <Input type="password" autoComplete="off" placeholder="sk-ant-…" value={v} onChange={(e) => setV(e.target.value)} className="min-w-0 flex-1 basis-60" aria-label="Anthropic API key" />
          <Button type="submit" variant="primary">Save</Button>
          {keyValue && <Button type="button" variant="ghost" onClick={() => onSave("")}>Remove key</Button>}
        </form>
      </CardBody>
    </Card>
  );
}
