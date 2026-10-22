import { Link, useParams } from "react-router-dom";
import { CircleDollarSign, Hourglass } from "lucide-react";
import { num, pct } from "@/lib/format";
import { NBA_MARKETS, bestOffer, bookName, edgeOf, fmtPrice, leanOf, marketLabel, nbaReasons, nbaTier, useNba, type NbaConfidence, type NbaDue, type PlayerPage } from "@/lib/nba";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody, CardHeader, LoadingBlock, TableWrap, Td, TeamBadge, Th } from "@/components/ui";
import { TierBadge } from "@/components/shared";
import { Headshot, NotPublished, ScoreSplit } from "./shared";

export default function NbaPlayer() {
  const { id } = useParams();
  const page = useNba<PlayerPage>(`players/${id}.json`);
  const conf = useNba<NbaConfidence>("confidence.json");
  const due = useNba<NbaDue>("due.json");
  if (page.isError) return <NotPublished error={new Error("Player pages are published for players in the next slate only.")} />;
  if (!page.data) return <Card><LoadingBlock rows={6} className="p-5" /></Card>;
  const p = page.data;
  const props = NBA_MARKETS.map((m) => p.props.find((r) => r.market === m.market)).filter((r): r is NonNullable<typeof r> => !!r);
  const first = props[0];
  const signals = props.map((r) => ({ r, lean: leanOf(r) })).map((x) => ({ ...x, edge: edgeOf(x.r, x.lean) }));
  const edges = signals.filter((s) => s.edge);
  const dues = props.filter((r) => r.due);
  return (
    <div className="space-y-5">
      <PageTitle kicker={<Link to="/nba/props" className="hover:text-accent">NBA · Player props</Link>} title={p.player_name}>
        <div className="flex items-center gap-2"><Headshot src={p.headshot} name={p.player_name} size={44} /><TeamBadge team={p.team} size="md" /></div>
      </PageTitle>
      {first && (
        <p className="text-sm text-muted">
          {first.home ? "vs" : "@"} {first.opp} · {num(first.evidence.minutes, 0)} minutes lately · starts {pct(first.evidence.start_rate, 0)} of games
          {first.injury && <span className={first.out ? " text-danger" : " text-warn"}> · {first.injury}{first.injury_note ? ` (${first.injury_note})` : ""}</span>}
        </p>
      )}
      {!!props.length && (
        <Card>
          <CardHeader title="Tonight's props" subtitle="Scores out of 10 for each side; the bigger one is the lean" />
          <TableWrap><table className="w-full">
            <thead><tr><Th>Market</Th><Th className="text-right">Proj</Th><Th className="text-right">Range</Th><Th>Line</Th><Th>Under · Over</Th><Th>Lean</Th><Th>Best price</Th></tr></thead>
            <tbody>
              {props.map((r) => {
                const lean = leanOf(r);
                const offer = lean ? bestOffer(r, lean.side) : null;
                return (
                  <tr key={r.market} className="border-b border-line/60">
                    <Td className="font-medium">{marketLabel(r.market)}</Td>
                    <Td className="text-right font-semibold">{num(r.mean, 1)}</Td>
                    <Td className="text-right text-muted">{num(r.q10, 0)}–{num(r.q90, 0)}</Td>
                    <Td>{r.line} <span className="text-[10px] text-muted">{r.line_source === "book" ? "book" : "usual"}</span></Td>
                    <Td>{lean ? <ScoreSplit over={lean.over} /> : <span className="text-xs text-muted">hidden</span>}</Td>
                    <Td>{lean ? <span className="flex items-center gap-1.5 whitespace-nowrap font-semibold">{lean.side === "over" ? "Over" : "Under"} {r.line}<TierBadge tier={nbaTier(conf.data, lean.p)} compact /></span> : "—"}</Td>
                    <Td className="whitespace-nowrap">{offer ? `${fmtPrice(offer.price)} ${bookName(offer.book)}` : <span className="text-muted">—</span>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table></TableWrap>
        </Card>
      )}
      {(edges.length > 0 || dues.length > 0) && (
        <Card><CardBody className="space-y-2 text-sm">
          <div className="font-semibold">Signals</div>
          {edges.map(({ r, lean, edge }) => (
            <div key={r.market} className="flex gap-2"><CircleDollarSign className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <span><b>Edge</b> on {lean!.side} {r.line} {marketLabel(r.market).toLowerCase()}: our {pct(lean!.p, 0)} vs {pct(edge!.implied, 0)} implied by {fmtPrice(edge!.price)} at {bookName(edge!.book)}.</span></div>
          ))}
          {dues.map((r) => {
            const s = due.data?.markets[r.market];
            return (
              <div key={r.market} className="flex gap-2"><Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                <span><b>Due</b> in {marketLabel(r.market).toLowerCase()}: under his projection in each of his last 4 games ({r.recent.slice(0, 4).map((v) => num(v, 0)).join(", ")} vs about {num(r.mean, 1)}).
                  {s && ` In testing, players in this spot beat their projection ${pct(s.beat_projection, 0)} of the time (others ${pct(s.others_beat_projection, 0)}), so the model already accounts for it.`}</span></div>
            );
          })}
        </CardBody></Card>
      )}
      {signals.filter((s) => s.lean).slice(0, 1).map(({ r, lean }) => (
        <Card key="why"><CardBody className="text-sm">
          <div className="font-semibold">Why {marketLabel(r.market).toLowerCase()} leans {lean!.side} {r.line}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{nbaReasons(r, lean!).map((t) => <li key={t}>{t}</li>)}</ul>
        </CardBody></Card>
      ))}
      <Card>
        <CardHeader title="Game log" subtitle="Most recent first" />
        <TableWrap><table className="w-full text-sm">
          <thead><tr><Th>Date</Th><Th>Opp</Th><Th className="text-right">Min</Th><Th className="text-right">PTS</Th><Th className="text-right">REB</Th><Th className="text-right">AST</Th><Th className="text-right">3PM</Th><Th className="text-right">PRA</Th></tr></thead>
          <tbody>
            {p.log.map((g) => (
              <tr key={g.date} className="border-b border-line/60">
                <Td className="text-muted">{g.date}</Td><Td>{g.home ? "vs" : "@"} {g.opp}</Td><Td className="text-right">{num(g.minutes, 0)}</Td>
                <Td className="text-right">{g.points}</Td><Td className="text-right">{g.rebounds}</Td><Td className="text-right">{g.assists}</Td>
                <Td className="text-right">{g.threes}</Td><Td className="text-right font-medium">{g.pra}</Td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      </Card>
    </div>
  );
}
