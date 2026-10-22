import { pct } from "@/lib/format";
import { MARKET_LABEL, useCfb, type Backtest, type CfbMarket, type CfbRecord, type Findings } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, LoadingBlock, Notice } from "@/components/ui";
import { NotPublished, TierLine, roiText } from "./shared";

const ORDER: CfbMarket[] = ["total", "spread", "moneyline", "team_total"];

export default function CfbResearch() {
  const bt = useCfb<Backtest>("backtest.json");
  const f = useCfb<Findings>("findings.json");
  const rec = useCfb<CfbRecord>("record.json");
  if (bt.isError) return <NotPublished error={bt.error} />;
  const b = bt.data;
  return (
    <div className="space-y-5">
      <PageTitle kicker="College football" title="Research and track record" />
      {!b && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {b && (
        <Notice title="The short version">
          Over {b.games.toLocaleString()} games ({b.first_season}-{b.last_season}), each played 5,000 times by the model as it stood before that week:
          game totals beat the price; closing spreads and moneylines did not. A pick needs a tier that hit at least {pct(b.break_even, 1)} (the -110 break-even)
          over the whole test and did not lose over {b.recent_seasons.join(" and ")}.
        </Notice>
      )}

      <Card>
        <CardHeader title="Live record" subtitle="Every game's leans are frozen on game day before kickoff and graded at the frozen line." />
        <CardBody className="text-sm">
          {!rec.data ? <LoadingBlock rows={2} /> : rec.data.picks === 0 ? <span className="text-muted">{rec.data.empty_reason}</span> : (
            <>
              <div>Suggested picks: <b>{rec.data.suggested?.hits}-{(rec.data.suggested?.n ?? 0) - (rec.data.suggested?.hits ?? 0)}</b> ({pct(rec.data.suggested?.rate, 1)}) over {rec.data.games} games since {rec.data.first_date}.</div>
              <table className="mt-3 w-full text-sm">
                <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Market</th><th className="text-left font-medium">Tier</th><th className="text-right font-medium">Leans</th><th className="text-right font-medium">Hit</th></tr></thead>
                <tbody>{rec.data.by_market_tier?.map((r) => (
                  <tr key={`${r.market}-${r.tier}`} className="border-t border-line/60"><td className="py-1">{MARKET_LABEL[r.market]}</td><td>{r.tier ?? "–"}</td>
                    <td className="text-right tabular-nums">{r.n}</td><td className="text-right tabular-nums">{r.market === "moneyline" ? roiText(r.roi) : pct(r.rate, 1)}</td></tr>
                ))}</tbody>
              </table>
            </>
          )}
        </CardBody>
      </Card>

      {b && ORDER.map((m) => {
        const r = b.markets[m];
        const money = m === "moneyline";
        return (
          <Card key={m}>
            <CardHeader title={<>{r.label} {r.proven ? <Badge tone="ok">Proven tier</Badge> : <Badge tone="warn">No proven tier</Badge>}</>}
              subtitle={money ? `Return per $1 at the closing moneyline, prices ${r.price_range?.[0]} to +${r.price_range?.[1]}, betting the side with the better expected return.`
                : m === "team_total" ? "Graded at the implied team total (half the total minus half the spread): old team-total lines were never archived, so these never become picks unless a book posts the line."
                : `Graded at the closing ${m === "total" ? "total" : "spread"}, pushes left out.`} />
            <CardBody className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Tier</th><th className="text-right font-medium">Leans</th>
                  <th className="text-right font-medium">{money ? "Return" : "Hit"}</th><th className="text-right font-medium">Last 2 seasons</th><th className="text-right font-medium" /></tr></thead>
                <tbody>{r.tiers.map((t) => <TierLine key={t.tier} t={t} money={money} />)}</tbody>
              </table>
              {m === "total" && r.by_side && (
                <p className="mt-3 text-xs text-muted">Strong tier by side: overs {pct(r.by_side.over?.find((t) => t.tier === "Strong")?.rate, 1)}, unders {pct(r.by_side.under?.find((t) => t.tier === "Strong")?.rate, 1)}.
                  {" "}Seasons (Strong tier): {r.by_season.map((s) => `${s.season} ${pct(s.rate, 0)}`).join(", ")}.</p>
              )}
            </CardBody>
          </Card>
        );
      })}

      {b?.opening_totals && (
        <Card>
          <CardHeader title="Bet totals early" subtitle="The same total leans graded at the opening line (the book's first number of the week) instead of the close." />
          <CardBody className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Tier</th><th className="text-right font-medium">Leans</th><th className="text-right font-medium">Hit</th><th className="text-right font-medium">Last 2 seasons</th><th /></tr></thead>
              <tbody>{b.opening_totals.tiers.map((t) => <TierLine key={t.tier} t={t} />)}</tbody>
            </table>
            <p className="mt-3 text-xs text-muted">Closing totals moved toward the model's side often enough that the edge is biggest early. The collector buys lines on Tuesday for this reason.</p>
          </CardBody>
        </Card>
      )}

      {f.data && (
        <Card>
          <CardHeader title="Patterns in closing lines" subtitle="Each measured in two separate eras. A pattern counts only if it beat the -110 break-even (or made money, for moneylines) in both." />
          <CardBody className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Pattern</th><th className="text-left font-medium">Side</th><th className="text-right font-medium">2014-21</th><th className="text-right font-medium">2022-26</th><th /></tr></thead>
              <tbody>{f.data.rules.map((r) => (
                <tr key={r.pattern} className="border-t border-line/60">
                  <td className="py-1.5 pr-3">{r.pattern}</td><td className="pr-3 text-muted">{r.side}</td>
                  {r.eras.map((e) => <td key={e.era} className="text-right tabular-nums">{r.market === "moneyline" ? roiText(e.roi) : pct(e.rate, 1)} <span className="text-xs text-muted">({e.n.toLocaleString()})</span></td>)}
                  <td className="pl-2 text-right">{r.holds ? <Badge tone="ok">Holds</Badge> : null}</td>
                </tr>
              ))}</tbody>
            </table>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="How it works" />
        <CardBody className="space-y-2 text-sm text-muted">
          <p><b className="text-fg">Data.</b> Every FBS game since 2010 with final scores and closing spreads, totals and moneylines from many books (cfbfastR / CollegeFootballData.com), ESPN team and player box scores, ESPN's daily scoreboard lines and sportsbook prices from The Odds API.</p>
          <p><b className="text-fg">Ratings.</b> Before every week, opponent-adjusted ratings for points, yards per play, plays (pace) and turnovers are refit on earlier games only. A game's weight halves every {b?.model.ratings_half_life_days ?? 120} days, so last season still counts in September and fades as new games come in.</p>
          <p><b className="text-fg">Game model.</b> The ratings and the posted line become an expected margin and total, refit every week on games the model never saw; a season's weight halves every {b?.model.recency_half_life_seasons ?? 2} seasons, so the last two count most.</p>
          <p><b className="text-fg">Simulation.</b> Each game is played {b?.model.sims.toLocaleString() ?? "5,000"} times with real misses from recent seasons (both teams' errors together, so scores stay realistic). Every chance on the site is the share of those games: cover, over, team total, win.</p>
          <p><b className="text-fg">Picks.</b> Score = chance x 10. Only tiers that beat the price in the backtest are suggested; every game's leans are frozen before kickoff and graded afterwards.</p>
          <p>Football research, not betting advice. No pick is guaranteed.</p>
        </CardBody>
      </Card>
    </div>
  );
}
