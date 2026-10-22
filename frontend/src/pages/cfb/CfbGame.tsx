import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { num, pct } from "@/lib/format";
import { MARKET_LABEL, bookName, fmtLine, fmtPrice, kick, ranked, useCfb, type Backtest, type Props, type Week } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody, CardHeader, LoadingBlock, Notice, Stat } from "@/components/ui";
import { LeanRow, NotPublished } from "./shared";

export default function CfbGame() {
  const { id } = useParams();
  const week = useCfb<Week>("week.json");
  const bt = useCfb<Backtest>("backtest.json");
  const props = useCfb<Props>("props.json");
  if (week.isError) return <NotPublished error={week.error} />;
  if (!week.data) return <Card><LoadingBlock rows={6} className="p-5" /></Card>;
  const g = week.data.games.find((x) => String(x.game_id) === id);
  if (!g) return <Notice title="Game not found">It may have finished; this page lists this week's games only. <Link to="/cfb" className="text-accent">Back to this week</Link></Notice>;
  const m = g.model;
  const fav = g.line.spread == null ? null : g.line.spread <= 0 ? `${g.home} ${fmtLine(g.line.spread)}` : `${g.away} ${fmtLine(-g.line.spread)}`;
  const pr = (props.data?.rows ?? []).filter((r) => r.game_id === g.game_id);
  return (
    <div className="space-y-5">
      <Link to="/cfb" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" />This week</Link>
      <PageTitle kicker={`${kick(g.date)}${g.tv ? ` · ${g.tv}` : ""}${g.venue ? ` · ${g.venue}` : ""}`}
        title={`${ranked(g.away, g.away_rank)} ${g.neutral ? "vs" : "at"} ${ranked(g.home, g.home_rank)}`} />

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Model score" value={`${num(m.away, 1)} – ${num(m.home, 1)}`} sub={`${g.away} – ${g.home}`} />
        <Stat label="Line" value={fav ?? "–"} sub={g.line.source ? `${g.line.source}` : "not posted yet"} />
        <Stat label="Total" value={g.line.total ?? "–"} sub={`model ${num(m.total, 1)}; 80% land ${m.total_q[0]}–${m.total_q[2]}`} />
        <Stat label={`${g.home} wins`} value={pct(m.home_win, 0)} sub={`margin ${m.margin_q[0] > 0 ? "+" : ""}${m.margin_q[0]} to ${m.margin_q[2] > 0 ? "+" : ""}${m.margin_q[2]} (80%)`} />
      </div>
      {(g.notes ?? []).map((n) => <Notice key={n} tone="warn" title="Check before betting">{n}</Notice>)}
      {g.upset && g.upset.p >= 0.3 && (
        <Notice title={g.upset.pick ? "Upset pick" : "Upset chance"}>
          {g.upset.team} wins {pct(g.upset.p, 0)} of the 5,000 simulated games{g.upset.market != null ? `; the moneyline${g.upset.price != null ? ` (${fmtPrice(g.upset.price)})` : ""} implies ${pct(g.upset.market, 0)}` : ""}.
          {g.upset.pick ? " That gap is in the moneyline value tier, which made money in testing." : ""}
        </Notice>
      )}
      {!m.line_based && <Notice tone="warn" title="No line yet">The score comes from the team ratings alone. Leans and picks appear once a book posts a line.</Notice>}

      {!!g.markets.length && (
        <Card>
          <CardHeader title="Every market" subtitle="Score = the model's chance out of 10 from 5,000 simulated games. Pushes are left out, as books refund them." />
          <div className="divide-y divide-line/60">
            {g.markets.map((x) => (
              <div key={`${x.market}-${x.team ?? ""}`}>
                <LeanRow m={x} bt={bt.data} />
                <ul className="list-disc space-y-0.5 px-8 pb-2.5 text-xs text-muted">
                  {x.reasons.map((r) => <li key={r}>{r}</li>)}
                  {!x.proven && <li>{MARKET_LABEL[x.market]} {x.tier ?? ""} leans did not beat the price in testing{x.market === "team_total" && !x.line_posted ? ", and this team total is implied, not posted" : ""}: shown for reference, not a pick.</li>}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Team ratings" subtitle="What each team is expected to do in this game: opponent-adjusted, refit before every week, the last two seasons count most. EPA and success rate leave out garbage time." />
        <CardBody className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-muted"><th className="text-left font-medium" /><th className="text-right font-medium">Expected points</th><th className="text-right font-medium">Yards per play</th><th className="text-right font-medium">Plays</th><th className="text-right font-medium">EPA/play</th><th className="text-right font-medium">Success</th></tr></thead>
            <tbody>
              {(["away", "home"] as const).map((s) => (
                <tr key={s} className="border-t border-line/60">
                  <td className="py-1.5 font-medium">{s === "home" ? g.home : g.away}</td>
                  <td className="text-right tabular-nums">{num(g.ratings[s].pts_for, 1)}</td>
                  <td className="text-right tabular-nums">{num(g.ratings[s].ypp, 2)}</td>
                  <td className="text-right tabular-nums">{num(g.ratings[s].plays, 0)}</td>
                  <td className="text-right tabular-nums">{num(g.ratings[s].epa, 2)}</td>
                  <td className="text-right tabular-nums">{pct(g.ratings[s].success, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {!!pr.length && (
        <Card>
          <CardHeader title="Player props" subtitle="Books post props for the big games only. Picks only at lines a book posted." />
          <div className="divide-y divide-line/60">
            {pr.slice(0, 20).map((r) => (
              <div key={`${r.player_id}-${r.market}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{r.player} <span className="text-xs text-muted">{r.team}</span></div>
                  <div className="text-xs text-muted">projects {num(r.mean, 1)} · last games {r.recent.slice(0, 5).join(", ")}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold">{r.side === "over" ? "Over" : "Under"} {r.line} {r.label.toLowerCase()}</div>
                  <div className="text-xs text-muted"><b className="text-fg">{r.score.toFixed(1)}</b>/10 · {r.line_source === "book" ? `book line${r.best ? `, ${fmtPrice(r.best.price)} ${bookName(r.best.book)}` : ""}` : "usual line"}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
