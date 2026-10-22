import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Dices, Download, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn, num, pct } from "@/lib/format";
import { feedLine, useFeed, type Feed } from "@/lib/feed";
import { pOver, type PropDist } from "@/lib/props";
import { bestPrice, coHits, simulate, toAmerican, toDecimal, type Buckets, type SimLeg } from "@/lib/sim";
import { csv, saveCsv } from "@/lib/static";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import type { RankingRow, RankingsResponse, Top3Response } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { Badge, Button, Card, CardBody, CardHeader, ErrorState, Input, LoadingBlock, Notice, PosBadge, Segmented, Select, TableWrap, Td, TeamBadge, Th } from "@/components/ui";

const BOOKS = ["DraftKings", "FanDuel", "BetMGM", "Caesars", "ESPN BET", "Fanatics"];
const SLIP_KEY = "fg-parlay-slip-v1";
const LINES_KEY = "fg-prop-lines-v1";

type Recent = { season: number; week: number; opponent: string; value: number };
type SlipLeg = SimLeg & {
  name: string; opponent: string; label: string; line?: number; dist?: PropDist; recent?: Recent[]; prices: Record<string, string>;
};
type Validation = { n: number; weeks: number; both_hit_rate: number; log_loss_gain: number; gain_ci: [number, number];
  independent: { log_loss: number; brier: number; mean_p: number }; correlated: { log_loss: number; brier: number; mean_p: number } };
type ParlayModel = {
  run_id: string | null; use_correlation: boolean; buckets: Buckets; note?: string; empty_reason?: string; events?: number; pairs?: number;
  validation: null | { pairs: Validation; triples: Validation; latest_season_pairs: Validation; by_relation: Record<string, Validation>;
    gate: { checks: { check: string; value: unknown; pass: boolean }[]; passed: boolean } };
};
type MarketMeta = { market: string; label: string; validated: boolean };
type PropRow = { player_id: string; player_name: string; team: string; opponent: string; position: string; game_id: string; eligible: number;
  median: number; q10: number; q90: number; dist: PropDist | null; recent?: Recent[] };
type PropsResp = { rows: PropRow[]; empty_reason?: string };
function feedPrices(feed: Feed, l: SlipLeg): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of feed.get(l.market, l.player_id, l.side)) {
    if (l.market !== "td" && r.line !== l.line) continue;
    out[r.book] = r.price > 0 ? `+${r.price}` : String(r.price);
  }
  return out;
}

function load<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || "") ?? fallback; } catch { return fallback; } }
function store(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } }

const tdLeg = (r: RankingRow): SlipLeg => ({
  id: `td:${r.player_id}`, market: "td", player_id: r.player_id, team: r.team, position: r.position, game_id: r.game_id ?? "",
  p: r.p_model as number, side: "yes", name: r.player_name, opponent: r.opponent ?? "", label: "Anytime TD", prices: {},
});
function propLeg(r: PropRow, market: string, label: string, line: number, side: "over" | "under"): SlipLeg {
  const over = pOver(r.dist as PropDist, line);
  return { id: `${market}:${r.player_id}`, market, player_id: r.player_id, team: r.team, position: r.position, game_id: r.game_id,
    p: side === "over" ? over : 1 - over, side, name: r.player_name, opponent: r.opponent, label, line, dist: r.dist ?? undefined,
    recent: r.recent, prices: {} };
}
const legText = (l: SlipLeg) => (l.market === "td" ? "Anytime TD" : `${l.side === "over" ? "Over" : "Under"} ${l.line} ${l.label.toLowerCase()}`);
const recentHits = (l: SlipLeg) => {
  if (l.market === "td" || l.line == null || !l.recent?.length) return null;
  const hits = l.recent.filter((g) => (l.side === "over" ? g.value > (l.line as number) : g.value < (l.line as number))).length;
  return { hits, games: l.recent.length };
};

export default function BuilderPage() {
  const { season, week } = useSeasonWeek();
  const [tab, setTab] = React.useState<"build" | "game">("build");
  const model = useQuery({ queryKey: ["parlay-model"], queryFn: () => api.get<ParlayModel>("/parlay/model") });
  const ranks = useQuery({ queryKey: ["rankings-all", season, week], queryFn: () => api.get<RankingsResponse>("/rankings", { season, week, eligible_only: true, page_size: 2000, sort: "rank", order: "asc" }) });
  const m = model.data;
  if (model.isError) return <Card><ErrorState error={model.error} onRetry={() => model.refetch()} /></Card>;
  return (
    <div className="space-y-5">
      <PageTitle kicker={`${season} · Week ${week}`} title="Parlay builder">
        <Segmented label="View" value={tab} onChange={setTab} options={[{ value: "build", label: "Build a parlay" }, { value: "game", label: "Simulate a game" }]} />
      </PageTitle>
      {tab === "build" ? <Build model={m} ranks={ranks.data} season={season} week={week} /> : <GameSim model={m} ranks={ranks.data} />}
      {m && <MethodCard m={m} />}
    </div>
  );
}

/* ------------------------------------------------------------------ build tab */
function Build({ model, ranks, season, week }: { model?: ParlayModel; ranks?: RankingsResponse; season: number; week: number }) {
  const slipKey = `${season}-${week}`;
  const [slip, setSlip] = React.useState<SlipLeg[]>(() => load<Record<string, SlipLeg[]>>(SLIP_KEY, {})[slipKey] ?? []);
  React.useEffect(() => setSlip(load<Record<string, SlipLeg[]>>(SLIP_KEY, {})[slipKey] ?? []), [slipKey]);
  React.useEffect(() => { const all = load<Record<string, SlipLeg[]>>(SLIP_KEY, {}); all[slipKey] = slip; store(SLIP_KEY, all); }, [slip, slipKey]);
  const [quoted, setQuoted] = React.useState<{ book: string; odds: string }>({ book: BOOKS[0], odds: "" });
  const feed = useFeed(season, week);
  const top3 = useQuery({ queryKey: ["top3", season, week, []], queryFn: () => api.get<Top3Response>("/weekly-top3", { season, week, exclude: [] }) });

  const withFeed = (l: SlipLeg): SlipLeg => ({ ...l, prices: { ...l.prices, ...feedPrices(feed, l) } });
  const add = (l: SlipLeg) => setSlip((s) => (s.some((x) => x.id === l.id) || s.length >= 10 ? s : [...s, withFeed(l)]));
  const refreshPrices = () => setSlip((s) => s.map(withFeed));
  const remove = (id: string) => setSlip((s) => s.filter((x) => x.id !== id));
  const setPrice = (id: string, book: string, v: string) => setSlip((s) => s.map((x) => (x.id === id ? { ...x, prices: { ...x.prices, [book]: v } } : x)));
  const setLine = (id: string, line: number) => setSlip((s) => s.map((x) => {
    if (x.id !== id || !x.dist || !Number.isFinite(line)) return x;
    const over = pOver(x.dist, line);
    const moved = { ...x, line, p: x.side === "over" ? over : 1 - over, prices: {} };
    return { ...moved, prices: feedPrices(feed, moved) };
  }));

  const useCorr = !!model?.use_correlation;
  const buckets = model?.buckets ?? {};
  const sim = React.useMemo(() => (slip.length ? simulate(slip, buckets, useCorr) : null), [slip, buckets, useCorr]);
  const sameGame = slip.some((a, i) => slip.some((b, j) => j > i && a.game_id === b.game_id));

  const best = slip.map((l) => bestPrice(l.prices));
  const allPriced = slip.length > 0 && best.every(Boolean);
  const combined = allPriced ? best.reduce((a, b) => a * (b as { decimal: number }).decimal, 1) : null;
  const quotedDec = toDecimal(quoted.odds);
  const price = quotedDec ?? combined;
  const ev = sim && price ? sim.joint * price - 1 : null;

  const loadTop3 = () => {
    const ids = new Set((top3.data?.legs ?? []).map((l) => l.player_id));
    const rows = (ranks?.rows ?? []).filter((r) => ids.has(r.player_id) && r.p_model != null);
    setSlip(rows.map((r) => withFeed(tdLeg(r))));
  };
  const exportCsv = () => {
    const head = ["season", "week", "player", "team", "opponent", "leg", "model_chance", "best_price", "best_book", ...BOOKS];
    const body = slip.map((l, i) => [season, week, l.name, l.team, l.opponent, legText(l), l.p.toFixed(4),
      best[i] ? toAmerican(best[i]!.decimal) : "", best[i]?.book ?? "", ...BOOKS.map((b) => l.prices[b] ?? "")]);
    const tail = sim ? [[], ["all legs hit (simulated)", sim.joint.toFixed(4)], ["multiplied as independent", sim.independent.toFixed(4)],
      ["price used", price ? toAmerican(price) : ""]] : [];
    saveCsv(`fourth-and-goal-parlay-${season}-w${week}.csv`, csv([head, ...body, ...tail]));
  };

  return (
    <>
      <Notice tone="info" title="How this works">
        Add legs from the anytime-TD model or from validated prop markets (type the book's line). Each leg's chance comes from a model that beat
        baselines on unseen weeks. The slip is then simulated 40,000 times: legs in different games are independent, legs in the same game move
        together the way they have in past games. Type each book's price and the best one is used. Nothing here is a sure thing.
      </Notice>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <Picker ranks={ranks} season={season} week={week} slip={slip} add={add} buckets={buckets} useCorr={useCorr} setSlip={(s) => setSlip(s.map(withFeed))} feed={feed} />
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title={`Your slip (${slip.length})`} subtitle={feed.at
              ? <>Prices filled from US sportsbooks (The Odds API) as of {new Date(feed.at).toLocaleString()}; edit any of them. <button className="underline" onClick={refreshPrices}>Refill</button></>
              : "Type each book's price: American (-110, +250) or decimal (2.50). No feed prices for this week yet."}
              />
            <div className="flex flex-wrap gap-2 border-b border-line px-4 py-2 sm:px-5">
                <Button size="sm" variant="outline" onClick={loadTop3} disabled={!top3.data?.legs?.length} title="Replace the slip with this week's Top 3">Load Top 3</Button>
                {slip.length > 0 && <Button size="sm" variant="ghost" onClick={exportCsv}><Download className="h-3.5 w-3.5" />CSV</Button>}
                {slip.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSlip([])}><Trash2 className="h-3.5 w-3.5" />Clear</Button>}
              </div>
            {!slip.length ? <CardBody className="text-sm text-muted">Add legs from the list, or use <b>Suggest</b> to start from the most likely combination.</CardBody> : (
              <ul className="divide-y divide-line">
                {slip.map((l, i) => {
                  const rh = recentHits(l);
                  const cond = sim?.conditional[i];
                  return (
                    <li key={l.id} className="space-y-2 px-4 py-3 sm:px-5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2"><TeamBadge team={l.team} /><PosBadge pos={l.position} /><span className="font-medium">{l.name}</span>
                            <span className="text-xs text-muted">vs {l.opponent}</span></div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                            {l.market === "td" ? <span>Anytime TD</span> : <>
                              <span>{l.side === "over" ? "Over" : "Under"}</span>
                              <Input aria-label={`Line for ${l.name}`} className="h-7 w-20 text-sm" type="number" step="0.5" defaultValue={l.line}
                                onBlur={(e) => setLine(l.id, Number(e.target.value))} />
                              <span>{l.label.toLowerCase()}</span></>}
                            {rh && <Badge title="Context only: the model already weighs recent games">{l.side === "over" ? "over" : "under"} in {rh.hits} of last {rh.games}</Badge>}
                          </div>
                        </div>
                        <div className="flex items-start gap-2">
                          <div className="text-right"><div className="font-display text-lg font-semibold">{pct(l.p, 0)}</div>
                            {sameGame && cond != null && Math.abs(cond - l.p) >= 0.01 && <div className="text-[11px] text-muted" title="This leg's chance in the simulations where every other leg hit">{pct(cond, 0)} if others hit</div>}
                          </div>
                          <button aria-label={`Remove ${l.name}`} onClick={() => remove(l.id)} className="rounded p-1 text-muted hover:bg-raised hover:text-fg"><X className="h-4 w-4" /></button>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                        {[...BOOKS, ...Object.keys(l.prices).filter((b) => !BOOKS.includes(b))].map((b) => {
                          const isBest = best[i]?.book === b && Object.values(l.prices).filter((v) => toDecimal(v ?? "")).length > 1;
                          return (
                            <label key={b} className="block">
                              <span className="block truncate text-[10px] uppercase tracking-wide text-muted">{b}</span>
                              <Input aria-label={`${b} price for ${l.name}`} placeholder="—" value={l.prices[b] ?? ""} onChange={(e) => setPrice(l.id, b, e.target.value)}
                                className={cn("h-7 px-2 text-xs", isBest && "border-ok ring-1 ring-ok")} />
                            </label>
                          );
                        })}
                      </div>
                      {best[i] && <div className="text-xs text-muted">Best: <b className="text-fg">{toAmerican(best[i]!.decimal)}</b> at {best[i]!.book} · price implies {pct(1 / best[i]!.decimal, 0)} vs our {pct(l.p, 0)}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          {sim && <Results sim={sim} slip={slip} useCorr={useCorr} sameGame={sameGame} combined={combined} quoted={quoted} setQuoted={setQuoted} price={price} ev={ev} />}
        </div>
      </div>
    </>
  );
}

function Results({ sim, slip, useCorr, sameGame, combined, quoted, setQuoted, price, ev }: {
  sim: ReturnType<typeof simulate>; slip: SlipLeg[]; useCorr: boolean; sameGame: boolean; combined: number | null;
  quoted: { book: string; odds: string }; setQuoted: (q: { book: string; odds: string }) => void; price: number | null; ev: number | null;
}) {
  const hot = slip.filter((l) => l.p >= 0.7);
  return (
    <Card>
      <CardHeader icon={<Dices className="h-4 w-4 text-accent" />} title="Simulation" subtitle={`${sim.draws.toLocaleString()} simulated games`} />
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-end gap-8">
          <div><div className="label">All {slip.length} legs hit</div><div className="font-display text-3xl font-semibold">{pct(sim.joint, 1)}</div>
            <div className="text-xs text-muted">±{pct(1.96 * sim.se, 1)} simulation noise</div></div>
          <div><div className="label">Multiplied as independent</div><div className="font-display text-xl">{pct(sim.independent, 1)}</div>
            <div className="text-xs text-muted">{sameGame ? (useCorr ? "differs because same-game legs move together" : "correlation not validated, so treated as independent") : "legs are in different games"}</div></div>
        </div>
        <div>
          <div className="label mb-1">How many legs hit</div>
          <ul className="space-y-1">{sim.hits.map((h, k) => (
            <li key={k} className="flex items-center gap-2 text-sm"><span className="w-16 text-muted">{k} of {slip.length}</span>
              <div className="h-2 flex-1 rounded bg-raised"><div className={cn("h-2 rounded", k === slip.length ? "bg-ok" : "bg-accent/60")} style={{ width: `${h * 100}%` }} /></div>
              <span className="w-12 text-right">{pct(h, 0)}</span></li>))}</ul>
        </div>
        <div className="rounded-lg border border-line p-3 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <div className="text-muted">Book's quoted parlay price <span className="text-xs">(optional; same-game parlays are priced differently from multiplying legs)</span></div>
            <Select aria-label="Book" value={quoted.book} onChange={(e) => setQuoted({ ...quoted, book: e.target.value })} className="h-8 w-32 text-xs">
              {BOOKS.map((b) => <option key={b}>{b}</option>)}</Select>
            <Input aria-label="Quoted parlay price" placeholder="+600" value={quoted.odds} onChange={(e) => setQuoted({ ...quoted, odds: e.target.value })} className="h-8 w-24 text-xs" />
          </div>
          {combined && <div className="mt-2 text-muted">Best prices multiplied: <b className="text-fg">{toAmerican(combined)}</b> (implies {pct(1 / combined, 1)})</div>}
          {price ? (
            <div className="mt-2 grid grid-cols-3 gap-3">
              <div><div className="label">Price implies</div><div className="font-semibold">{pct(1 / price, 1)}</div></div>
              <div><div className="label">Our chance</div><div className="font-semibold">{pct(sim.joint, 1)}</div></div>
              <div><div className="label" title="Average return per $10 if our chance is right; includes the book's margin">Per $10, on average</div>
                <div className={cn("font-semibold", ev! > 0 ? "text-ok" : "text-danger")}>{ev! >= 0 ? "+" : "−"}${Math.abs(ev! * 10).toFixed(2)}</div></div>
            </div>
          ) : <div className="mt-2 text-xs text-muted">Type a price for every leg (or the book's parlay price) to compare against our chance.</div>}
        </div>
        {hot.length > 0 && <Notice tone="warn">Chances of 70% or more are where past predictions were thinnest; treat {hot.map((l) => l.name).join(", ")} with extra care.</Notice>}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ leg picker */
function Picker({ ranks, season, week, slip, add, buckets, useCorr, setSlip, feed }: {
  ranks?: RankingsResponse; season: number; week: number; slip: SlipLeg[]; add: (l: SlipLeg) => void; buckets: Buckets; useCorr: boolean;
  setSlip: (s: SlipLeg[]) => void; feed: Feed;
}) {
  const suffix = useLinkSuffix();
  const [source, setSource] = React.useState("td");
  const [search, setSearch] = React.useState("");
  const [lines, setLines] = React.useState<Record<string, { line?: string; odds?: string }>>(() => load(LINES_KEY, {}));
  React.useEffect(() => store(LINES_KEY, lines), [lines]);
  const [nLegs, setNLegs] = React.useState(3);
  const [sameGameOk, setSameGameOk] = React.useState(true);
  const markets = useQuery({ queryKey: ["props-markets"], queryFn: () => api.get<{ markets: MarketMeta[] }>("/props/markets") });
  const validated = (markets.data?.markets ?? []).filter((x) => x.validated);
  const meta = validated.find((x) => x.market === source);
  const props = useQuery({ queryKey: ["props", season, week, source], enabled: source !== "td",
    queryFn: () => api.get<PropsResp>("/props", { season, week, market: source }) });
  const inSlip = new Set(slip.map((l) => l.id));
  const q = search.toLowerCase();
  const tdRows = (ranks?.rows ?? []).filter((r) => r.p_model != null && r.game_id && (!q || r.player_name.toLowerCase().includes(q)))
    .sort((a, b) => (b.p_model as number) - (a.p_model as number));
  const propRows = (props.data?.rows ?? []).filter((r) => r.eligible && r.dist && (!q || r.player_name.toLowerCase().includes(q)));
  const lineKey = (r: PropRow) => `${season}-${week}-${source}-${r.player_id}`;
  const lineOf = (r: PropRow) => lines[lineKey(r)]?.line ?? (feedLine(feed, source, r.player_id)?.toString() ?? "");

  // Suggest: greedily add the leg that keeps the simulated all-hit chance highest.
  const suggest = () => {
    const pool: SlipLeg[] = tdRows.slice(0, 30).map(tdLeg);
    if (source !== "td" && meta) {
      for (const r of propRows) {
        const raw = lineOf(r), ln = Number(raw);
        if (!raw || !Number.isFinite(ln)) continue;
        for (const side of ["over", "under"] as const) { const l = propLeg(r, source, meta.label, ln, side); if (l.p >= 0.5) pool.push(l); }
      }
    }
    const chosen: SlipLeg[] = [];
    for (let k = 0; k < nLegs; k++) {
      let bestLeg: SlipLeg | null = null, bestP = -1;
      for (const c of pool) {
        if (chosen.some((x) => x.id === c.id || (x.player_id === c.player_id && x.market === c.market))) continue;
        if (!sameGameOk && chosen.some((x) => x.game_id === c.game_id)) continue;
        const p = simulate([...chosen, c], buckets, useCorr, 6000, 99).joint;
        if (p > bestP) { bestP = p; bestLeg = c; }
      }
      if (!bestLeg) break;
      chosen.push(bestLeg);
    }
    setSlip(chosen);
  };

  return (
    <Card className="min-w-0">
      <CardHeader title="Add legs" subtitle="Only markets whose chances passed validation are offered" />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Market" value={source} onChange={(e) => setSource(e.target.value)} className="w-48">
            <option value="td">Anytime TD</option>
            {validated.map((x) => <option key={x.market} value={x.market}>{x.label}</option>)}
          </Select>
          <div className="relative min-w-0 flex-1 basis-40">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
            <Input aria-label="Search players" placeholder="Search players" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-raised/50 p-2 text-sm">
          <Sparkles className="h-4 w-4 text-accent" aria-hidden />
          <span>Suggest the most likely</span>
          <Select aria-label="Number of legs" value={nLegs} onChange={(e) => setNLegs(Number(e.target.value))} className="h-8 w-16 text-xs">
            {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
          <span>legs</span>
          <label className="flex items-center gap-1 text-xs text-muted"><input type="checkbox" checked={sameGameOk} onChange={(e) => setSameGameOk(e.target.checked)} />same game allowed</label>
          <Button size="sm" variant="primary" onClick={suggest} disabled={!tdRows.length}>Suggest</Button>
          <span className="w-full text-xs text-muted">Uses the top anytime-TD chances{source !== "td" ? " plus every prop in this market that has a line" : ""}. Most likely is not the same as best value: add prices to compare.</span>
        </div>
        {source === "td" ? (
          !ranks ? <LoadingBlock rows={6} /> : !tdRows.length ? <div className="text-sm text-muted">No validated anytime-TD chances for this week.</div> : (
            <TableWrap className="max-h-[560px] overflow-y-auto">
              <table className="w-full"><thead className="sticky top-0 bg-surface"><tr><Th>Player</Th><Th className="hidden sm:table-cell">Opp</Th><Th className="text-right">Chance</Th><Th /></tr></thead>
                <tbody>{tdRows.slice(0, 150).map((r) => (
                  <tr key={r.player_id} className="border-b border-line/60">
                    <Td><div className="flex items-center gap-2"><span className="hidden sm:inline-flex"><TeamBadge team={r.team} /></span><PosBadge pos={r.position} /><Link className="whitespace-normal hover:text-accent" to={`/players/${r.player_id}${suffix}`}>{r.player_name}</Link></div></Td>
                    <Td className="hidden text-muted sm:table-cell">{r.opponent}</Td><Td className="text-right font-semibold">{pct(r.p_model, 0)}</Td>
                    <Td className="text-right"><Button size="sm" variant="outline" disabled={inSlip.has(`td:${r.player_id}`)} onClick={() => add(tdLeg(r))}><Plus className="h-3.5 w-3.5" />Add</Button></Td>
                  </tr>))}</tbody></table>
            </TableWrap>)
        ) : props.isLoading ? <LoadingBlock rows={6} /> : props.data?.empty_reason ? <div className="text-sm text-muted">{props.data.empty_reason}</div> : (
          <TableWrap className="max-h-[560px] overflow-y-auto">
            <table className="w-full"><thead className="sticky top-0 bg-surface"><tr><Th>Player</Th><Th className="text-right">Proj.</Th><Th title="Pre-filled with the line most books offer, when prices have been fetched">Book line</Th>
              <Th className="text-right">Over</Th><Th className="text-right">Under</Th><Th /></tr></thead>
              <tbody>{propRows.map((r) => {
                const raw = lineOf(r);
                const ln = Number(raw);
                const ok = raw !== "" && Number.isFinite(ln);
                const over = ok ? pOver(r.dist as PropDist, ln) : null;
                const id = `${source}:${r.player_id}`;
                return (
                  <tr key={r.player_id} className="border-b border-line/60">
                    <Td><div className="flex items-center gap-2"><span className="hidden sm:inline-flex"><TeamBadge team={r.team} /></span><PosBadge pos={r.position} /><span className="whitespace-normal">{r.player_name}</span></div>
                      <div className="text-xs text-muted">vs {r.opponent} · range {num(r.q10, 0)}–{num(r.q90, 0)}</div></Td>
                    <Td className="text-right">{num(r.median, 1)}</Td>
                    <Td><Input aria-label={`Line for ${r.player_name}`} type="number" step="0.5" placeholder="line" className="h-8 w-20 text-sm" value={raw}
                      onChange={(e) => setLines((s) => ({ ...s, [lineKey(r)]: { ...s[lineKey(r)], line: e.target.value } }))} /></Td>
                    <Td className="text-right">{over != null ? pct(over, 0) : "—"}</Td><Td className="text-right">{over != null ? pct(1 - over, 0) : "—"}</Td>
                    <Td className="whitespace-nowrap text-right">
                      <Button size="sm" variant="outline" disabled={!ok || inSlip.has(id)} onClick={() => add(propLeg(r, source, meta?.label ?? source, ln, "over"))}>Over</Button>{" "}
                      <Button size="sm" variant="outline" disabled={!ok || inSlip.has(id)} onClick={() => add(propLeg(r, source, meta?.label ?? source, ln, "under"))}>Under</Button>
                    </Td>
                  </tr>);
              })}</tbody></table>
          </TableWrap>
        )}
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ game simulator */
function GameSim({ model, ranks }: { model?: ParlayModel; ranks?: RankingsResponse }) {
  const suffix = useLinkSuffix();
  const games = React.useMemo(() => {
    const g = new Map<string, { id: string; teams: string[] }>();
    for (const r of ranks?.rows ?? []) {
      if (!r.game_id || r.p_model == null) continue;
      const e = g.get(r.game_id) ?? { id: r.game_id, teams: [] };
      if (!e.teams.includes(r.team)) e.teams.push(r.team);
      g.set(r.game_id, e);
    }
    return [...g.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [ranks]);
  const [gameId, setGameId] = React.useState("");
  const gid = gameId || games[0]?.id || "";
  const legs = React.useMemo(() => (ranks?.rows ?? []).filter((r) => r.game_id === gid && r.p_model != null)
    .sort((a, b) => (b.p_model as number) - (a.p_model as number)).slice(0, 16).map(tdLeg), [ranks, gid]);
  const useCorr = !!model?.use_correlation;
  const res = React.useMemo(() => (legs.length ? coHits(legs, model?.buckets ?? {}, useCorr) : null), [legs, model, useCorr]);
  if (!ranks) return <Card><LoadingBlock rows={6} className="p-5" /></Card>;
  if (!games.length) return <Notice tone="info">No validated anytime-TD chances for this week.</Notice>;
  const pairs: { a: number; b: number; both: number; ind: number }[] = [];
  if (res) for (let i = 0; i < legs.length; i++) for (let j = i + 1; j < legs.length; j++) pairs.push({ a: i, b: j, both: res.both[i][j], ind: legs[i].p * legs[j].p });
  pairs.sort((x, y) => y.both - x.both);
  const teams = [...new Set(legs.map((l) => l.team))];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label="Game" value={gid} onChange={(e) => setGameId(e.target.value)} className="w-64">
          {games.map((g) => <option key={g.id} value={g.id}>{g.teams.join(" vs ")}</option>)}
        </Select>
        <span className="text-sm text-muted">30,000 simulated games using each player's validated TD chance{useCorr ? " and same-game correlation" : ""}.</span>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Most likely scoring pairs" subtitle="Chance both score, compared with multiplying their chances" />
          <TableWrap>
            <table className="w-full"><thead><tr><Th>Pair</Th><Th className="text-right">Both score</Th><Th className="text-right">Multiplied</Th></tr></thead>
              <tbody>{pairs.slice(0, 12).map((p) => (
                <tr key={`${p.a}-${p.b}`} className="border-b border-line/60">
                  <Td><div className="text-sm">{legs[p.a].name} <span className="text-muted">({legs[p.a].team})</span> + {legs[p.b].name} <span className="text-muted">({legs[p.b].team})</span></div></Td>
                  <Td className="text-right font-semibold">{pct(p.both, 1)}</Td><Td className="text-right text-muted">{pct(p.ind, 1)}</Td></tr>))}</tbody></table>
          </TableWrap>
        </Card>
        <Card>
          <CardHeader title="Players in this game" subtitle="Validated anytime-TD chance (top 16 by chance)" />
          <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {teams.map((t) => (
              <div key={t}><div className="label mb-1 flex items-center gap-2"><TeamBadge team={t} />{t}</div>
                <ul className="space-y-1 text-sm">{legs.filter((l) => l.team === t).map((l) => (
                  <li key={l.id} className="flex justify-between gap-2"><Link className="truncate hover:text-accent" to={`/players/${l.player_id}${suffix}`}>{l.name}</Link><span className="font-medium">{pct(l.p, 0)}</span></li>))}</ul>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ method */
function MethodCard({ m }: { m: ParlayModel }) {
  const v = m.validation;
  if (!v) return <Notice tone="info">{m.empty_reason}</Notice>;
  const row = (label: string, x: Validation) => (
    <tr key={label} className="border-b border-line/60"><Td>{label}</Td><Td className="text-right">{x.n.toLocaleString()}</Td><Td className="text-right">{pct(x.both_hit_rate, 1)}</Td>
      <Td className="text-right">{num(x.independent.log_loss, 4)}</Td><Td className="text-right">{num(x.correlated.log_loss, 4)}</Td>
      <Td className={cn("text-right", x.log_loss_gain > 0 ? "text-ok" : "text-danger")}>{x.log_loss_gain >= 0 ? "+" : ""}{num(x.log_loss_gain * 1000, 2)}</Td></tr>);
  return (
    <Card>
      <CardHeader title="Is the same-game correlation real?" subtitle={`Tested week by week on ${v.pairs.weeks} unseen weeks; each week's correlations were learned only from earlier weeks`}
        action={<Badge tone={m.use_correlation ? "ok" : "warn"}>{m.use_correlation ? "Passed: used" : "Not passed: legs multiplied"}</Badge>} />
      <TableWrap>
        <table className="w-full"><thead><tr><Th>Same-game combos</Th><Th className="text-right">Tested</Th><Th className="text-right">All hit</Th>
          <Th className="text-right" title="Lower is better">Error: multiplied</Th><Th className="text-right" title="Lower is better">Error: correlated</Th>
          <Th className="text-right" title="Log-loss improvement ×1000">Gain</Th></tr></thead>
          <tbody>
            {row("2 legs, any relation", v.pairs)}
            {row("2 legs, same player", v.by_relation.player)}
            {row("2 legs, teammates", v.by_relation.team)}
            {row("2 legs, opponents", v.by_relation.opp)}
            {row("3 legs", v.triples)}
            {row("2 legs, this season only", v.latest_season_pairs)}
          </tbody></table>
      </TableWrap>
      <CardBody className="space-y-1 text-xs text-muted">
        <p>Strongest links found: a quarterback going over his passing-TD line and his receivers scoring rise and fall together; a player's receptions over and his own TD go together; two teammates both scoring is slightly less likely than multiplying suggests, because they share the same touchdowns.</p>
        <p>Error is log loss on whether every leg hit. The opponents-only row is close to zero, which is why opposing legs are treated as nearly independent. {m.note}</p>
      </CardBody>
    </Card>
  );
}
