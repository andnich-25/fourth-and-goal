/* The optional AI mode shared by every Ask page: the key panel, the AI/Built-in switch, and an answer card. */
import * as React from "react";
import { Bot, KeyRound, Loader2 } from "lucide-react";
import { cn } from "@/lib/format";
import { loadKey, MODEL, saveKey } from "@/lib/aiKey";
import { Button, Card, CardBody, CardHeader, Input, Notice } from "@/components/ui";

export function useAiMode() {
  const [key, setKey] = React.useState(loadKey);
  const [useAi, setUseAi] = React.useState(() => !!loadKey());
  const [showKey, setShowKey] = React.useState(false);
  const save = (k: string) => { saveKey(k); setKey(k); setUseAi(!!k); setShowKey(false); };
  return { key, on: useAi && !!key, setUseAi, showKey, setShowKey, save };
}
export type AiMode = ReturnType<typeof useAiMode>;

/** The AI/Built-in switch, plus a link to the key panel. */
export function AiToggle({ ai }: { ai: AiMode }) {
  return (
    <button type="button" onClick={() => (ai.key ? ai.setUseAi((v) => !v) : ai.setShowKey(true))} title={ai.key ? "Switch between AI and built-in answers" : "Turn on AI answers"}
      className={cn("flex h-9 items-center gap-1 rounded-lg px-2 text-xs font-medium", ai.on ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised")}>
      <Bot className="h-4 w-4" aria-hidden />{ai.on ? "AI" : "Built-in"}
    </button>
  );
}
export function AiKeyLink({ ai }: { ai: AiMode }) {
  return <button className="text-[11px] text-muted underline" onClick={() => ai.setShowKey(!ai.showKey)}><KeyRound className="mr-1 inline h-3 w-3" />AI answers</button>;
}

export function KeyPanel({ keyValue, onSave }: { keyValue: string; onSave: (k: string) => void }) {
  const [v, setV] = React.useState(keyValue);
  return (
    <Card>
      <CardHeader icon={<Bot className="h-4 w-4 text-accent" />} title="AI answers (optional)" subtitle="Lets Claude understand any wording and write detailed breakdowns. It can only use the site's numbers, through the same functions as the built-in answers." />
      <CardBody className="space-y-3 text-sm">
        <p className="text-muted">Paste an Anthropic API key (from console.anthropic.com). It is saved only in this browser and sent only to Anthropic. Each question
          costs a few cents on that key (model {MODEL}). Built-in answers stay free and work without a key. The same key works on every sport's Ask page.</p>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); onSave(v.trim()); }}>
          <Input type="password" autoComplete="off" placeholder="sk-ant-…" value={v} onChange={(e) => setV(e.target.value)} className="min-w-0 flex-1 basis-60" aria-label="Anthropic API key" />
          <Button type="submit" variant="primary">Save</Button>
          {keyValue && <Button type="button" variant="ghost" onClick={() => onSave("")}>Remove key</Button>}
        </form>
      </CardBody>
    </Card>
  );
}

/** The AI's reply: "#" lines become headings and "-" lines bullets; everything else is a paragraph. */
export function AiText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={blocks.length} className="list-disc space-y-1 pl-5">{list.map((l, i) => <li key={i}>{l}</li>)}</ul>); list = []; } };
  for (const raw of text.replace(/\*\*(.+?)\*\*/g, "$1").split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    const b = line.match(/^[-*•]\s+(.*)$/);
    if (b) { list.push(b[1]); continue; }
    flush();
    blocks.push(h ? <h3 key={blocks.length} className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted">{h[1]}</h3> : <p key={blocks.length}>{line}</p>);
  }
  flush();
  return <div className="space-y-2 text-sm leading-relaxed">{blocks}</div>;
}

export function AiCard({ text, status, error }: { text?: string; status?: string; error?: string }) {
  return (
    <>
      {status && <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />{status}</div>}
      {error && <Notice tone="warn">{error} Showing the built-in answer instead.</Notice>}
      {text && (
        <Card><CardBody className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted"><Bot className="h-3.5 w-3.5" />AI answer from the site's numbers</div>
          <AiText text={text} />
        </CardBody></Card>
      )}
    </>
  );
}

/** Runs the AI on one question (the single-answer Ask pages); falls back to the built-in answer on error. */
export function useAiAnswer(question: string, enabled: boolean, run: ((q: string, onStatus: (s: string) => void) => Promise<string>) | null) {
  const [st, setSt] = React.useState<{ q: string; text?: string; status?: string; error?: string }>({ q: "" });
  React.useEffect(() => {
    if (!enabled || !question || !run) return;
    let live = true;
    setSt({ q: question, status: "Thinking…" });
    run(question, (s) => live && setSt((x) => ({ ...x, status: s })))
      .then((text) => live && setSt({ q: question, text }))
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (live) setSt({ q: question, error: /401|auth|api.key/i.test(msg) ? "The API key was not accepted. Check it under AI answers." : msg });
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question, enabled, !!run]);
  return enabled && st.q === question ? st : null;
}
