import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { MessageCircleQuestion } from "lucide-react";
import { pct } from "@/lib/format";
import { MARKET_LABEL, dayOf, fmtLine, kick, useCfb, type Backtest, type CfbGame, type CfbStatus, type Week } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody, CardHeader, Input, LoadingBlock, Notice, Segmented } from "@/components/ui";
import { LeanRow, Matchup, NotPublished } from "./shared";

export default function CfbHome() {
  const week = useCfb<Week>("week.json");
  const bt = useCfb<Backtest>("backtest.json");
  const status = useCfb<CfbStatus>("status.json");
  const nav = useNavigate();
  const [q, setQ] = React.useState("");
  const [show, setShow] = React.useState<"featured" | "all">("featured");
  const [find, setFind] = React.useState("");
  if (week.isError) return <NotPublished error={week.error} />;
  const w = week.data;
  const games = (w?.games ?? []).filter((g) => (show === "all" || g.featured || find) &&
    (!find || `${g.home} ${g.away}`.toLowerCase().includes(find.toLowerCase())));
  const byDay = new Map<string, CfbGame[]>();
  for (const g of games) byDay.set(dayOf(g.date), [...(byDay.get(dayOf(g.date)) ?? []), g]);
  const totals = bt.data?.markets.total;
  const strong = totals?.tiers.find((t) => t.proven);
  return (
    <div className="space-y-5">
      <PageTitle kicker={w?.games[0] ? `College football ${status.data?.season ?? ""} · Week ${w.games[0].week}` : "College football"} title="This week" />
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/cfb/ask?q=${encodeURIComponent(q.trim())}`); }} className="relative">
        <MessageCircleQuestion className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask: best totals this week, Alabama spread, top 10 teams…" className="pl-9" aria-label="Ask a question" />
      </form>
      {week.isLoading && <Card><LoadingBlock rows={5} className="p-5" /></Card>}

      {w && (
        <Card>
          <CardHeader title="Picks"
            subtitle={strong ? `Only tiers that beat the -110 break-even on games the model never saw. ${MARKET_LABEL.total} picks in this tier hit ${pct(strong.rate, 1)} of ${strong.n.toLocaleString()} (${pct(strong.recent_rate, 1)} the last two seasons).` : "Only tiers that beat the -110 break-even on games the model never saw."} />
          <div className="divide-y divide-line/60">
            {w.picks.map((p) => (
              <LeanRow key={`${p.game_id}-${p.market}-${p.team ?? ""}`} m={p} bt={bt.data} to={`/cfb/game/${p.game_id}`}
                sub={<>{p.away} at {p.home} · {kick(p.date)}</>} />
            ))}
          </div>
          {!w.picks.length && <CardBody className="text-sm text-muted">No game reaches a proven tier yet. Picks appear when books post lines (Tuesday and Saturday pulls, ESPN daily).</CardBody>}
        </Card>
      )}

      {bt.data && (
        <Notice title="What the backtest says">
          Game totals are where the model earns its keep{strong ? ` (${pct(strong.rate, 1)} at the closing line, better at the opening line, so bet totals early in the week)` : ""}.
          Closing spreads and moneylines were too sharp: no tier beat the price over {bt.data.first_season}-{bt.data.last_season}, so they are shown as leans, never as picks.
          {" "}<Link to="/cfb/research" className="text-accent hover:underline">See the research</Link>
        </Notice>
      )}

      {w && (
        <Card>
          <CardHeader title="Games" subtitle="Model score and 5,000-game simulation for every FBS game this week. Featured = ranked matchups."
            action={<Segmented size="sm" label="Show" value={show} onChange={setShow} options={[{ value: "featured", label: "Featured" }, { value: "all", label: "All" }]} />} />
          <div className="border-b border-line p-3"><Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a team" aria-label="Find a team" /></div>
          {[...byDay.entries()].map(([day, gs]) => (
            <div key={day}>
              <div className="label bg-raised/50 px-4 py-1.5">{day}</div>
              <div className="divide-y divide-line/60">{gs.map((g) => <GameLine key={g.game_id} g={g} />)}</div>
            </div>
          ))}
          {!games.length && <CardBody className="text-sm text-muted">{show === "featured" ? "No featured games this week. Switch to All." : "No games match."}</CardBody>}
        </Card>
      )}
      {status.data && (
        <Card><CardBody className="text-xs text-muted">
          Built from {status.data.history.games.toLocaleString()} games since {status.data.history.first_season} ({status.data.history.lined_games.toLocaleString()} with closing lines).
          Ratings are refit before every week and the last two seasons count most. Latest final {status.data.history.last_game_date}.
          {" "}<Link to="/cfb/research" className="text-accent hover:underline">How it works</Link>
        </CardBody></Card>
      )}
    </div>
  );
}

function GameLine({ g }: { g: CfbGame }) {
  const sp = g.markets.find((m) => m.market === "spread");
  const tot = g.markets.find((m) => m.market === "total");
  const fav = g.line.spread == null ? null : g.line.spread <= 0 ? `${g.home} ${fmtLine(g.line.spread)}` : `${g.away} ${fmtLine(-g.line.spread)}`;
  return (
    <Link to={`/cfb/game/${g.game_id}`} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm hover:bg-raised/50 sm:grid-cols-[1fr_9rem_9rem]">
      <div className="min-w-0">
        <Matchup g={g} className="font-medium" />
        <div className="text-xs text-muted">{kick(g.date)}{g.tv ? ` · ${g.tv}` : ""} · {fav ? `${fav}, O/U ${g.line.total ?? "–"}` : "no line yet"}</div>
      </div>
      <div className="text-right text-xs sm:text-sm">
        <div className="font-semibold tabular-nums">{g.away} {g.model.away.toFixed(0)}, {g.home} {g.model.home.toFixed(0)}</div>
        <div className="text-muted">model score</div>
      </div>
      <div className="col-span-2 text-xs text-muted sm:col-span-1 sm:text-right">
        {sp && <div>{sp.team} {fmtLine(sp.line!)} <b className="text-fg">{sp.score.toFixed(1)}</b></div>}
        {tot && <div className={tot.proven ? "text-ok" : ""}>{tot.side === "over" ? "Over" : "Under"} {tot.line} <b className="text-fg">{tot.score.toFixed(1)}</b></div>}
      </div>
    </Link>
  );
}
