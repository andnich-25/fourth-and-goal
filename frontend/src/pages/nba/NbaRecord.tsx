import { Check, X } from "lucide-react";
import { cn, num, pct } from "@/lib/format";
import { useNba, type PostGame, type MarketReport, type NbaConfidence, type NbaCorrelation, type NbaDue, type NbaRecord as Rec } from "@/lib/nba";
import type { Tier } from "@/lib/confidence";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, LoadingBlock, Notice, TableWrap, Td, Th } from "@/components/ui";
import { TierBadge } from "@/components/shared";

const CHECKS: Record<string, string> = {
  enough_rows: "5,000+ test games", enough_weeks: "10+ test months", beats_baselines_crps: "Closer to results than his average",
  crps_gain_ci_excludes_zero: "Improvement is statistically clear", beats_baselines_over_brier: "Better over/under calls than his average",
  over_calibrated: "Chances are honest (within 2.5 pts)", latest_season_not_worse: "Holds up last season",
};

export function TierTable({ tiers, label = "Picks" }: { tiers: Tier[]; label?: string }) {
  return (
    <TableWrap><table className="w-full text-sm">
      <thead><tr><Th>Band</Th><Th className="text-right">Score</Th><Th className="text-right">{label}</Th><Th className="text-right">Model said</Th><Th className="text-right">Hit</Th></tr></thead>
      <tbody>{tiers.map((t) => (
        <tr key={t.tier} className="border-b border-line/60">
          <Td><TierBadge tier={t} compact /></Td>
          <Td className="text-right text-muted">{t.hi >= 1 ? `${(t.lo * 10).toFixed(1)}+` : `${(t.lo * 10).toFixed(1)}–${(t.hi * 10).toFixed(1)}`}</Td>
          <Td className="text-right">{t.n.toLocaleString()}</Td>
          <Td className="text-right text-muted">{pct(t.avg_chance, 1)}</Td>
          <Td className="text-right font-semibold">{pct(t.rate, 1)}</Td>
        </tr>
      ))}</tbody>
    </table></TableWrap>
  );
}

const signed = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}`);

function PostGameCard({ pg, check }: { pg: PostGame; check: NonNullable<Rec["projection_check"]> }) {
  const bias = Object.fromEntries(check.map((c) => [c.market, c]));
  return (
    <Card>
      <CardHeader title="Post-game review" subtitle="Every graded projection re-run with the minutes each player really played, to see which input was off" />
      <CardBody className="space-y-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-line p-3"><div className="label">Minutes vs projected</div>
            <div className="text-lg font-semibold">{signed(pg.minutes?.bias)} min</div><div className="text-xs text-muted">off by {num(pg.minutes?.avg_miss, 1)} on average ({pg.minutes?.players} player-games)</div></div>
          <div className="rounded-lg border border-line p-3"><div className="label">Losses minutes explain</div>
            <div className="text-lg font-semibold">{pg.lost_minutes_explain} of {pg.lost}</div><div className="text-xs text-muted">right side had we known his minutes</div></div>
          <div className="rounded-lg border border-line p-3"><div className="label">Team rotation points</div>
            <div className="text-lg font-semibold">{signed(pg.team_rotation?.bias)}</div><div className="text-xs text-muted">vs projected, off by {num(pg.team_rotation?.avg_miss, 1)} ({pg.team_rotation?.games ?? 0} team-games)</div></div>
        </div>
        <TableWrap><table className="w-full">
          <thead><tr><Th>Market</Th><Th className="text-right">Graded</Th><Th className="text-right" title="Actual minus projected: positive means players beat the projection">Bias</Th><Th className="text-right">Last 7 days</Th><Th className="text-right">Miss from minutes</Th><Th className="text-right">Miss from production</Th></tr></thead>
          <tbody>{(pg.by_market ?? []).map((m) => (
            <tr key={m.market} className="border-b border-line/60"><Td>{m.label}</Td><Td className="text-right">{m.n.toLocaleString()}</Td>
              <Td className="text-right">{signed(bias[m.market]?.bias, 2)}</Td><Td className="text-right text-muted">{signed(bias[m.market]?.last7_bias, 2)}</Td>
              <Td className="text-right">{num(m.minutes_part, 2)}</Td><Td className="text-right">{num(m.rate_part, 2)}</Td></tr>
          ))}</tbody>
        </table></TableWrap>
        {pg.injury_listed?.n ? <p className="text-muted">Players on the injury report when we saved the lean: {pg.injury_listed.n} props, {pct(pg.injury_listed.hit, 0)} hit, minutes {signed(pg.injury_listed.minutes_bias)} vs projected.</p> : null}
        <p className="text-xs text-muted">The models refit every day on these games. A run of misses from minutes points at playing-time news (the late injury run exists for that); a bias that stays away from 0 for weeks in one market is the signal to retune it.</p>
      </CardBody>
    </Card>
  );
}

export default function NbaRecord() {
  const markets = useNba<{ markets: MarketReport[] }>("markets.json");
  const conf = useNba<NbaConfidence>("confidence.json");
  const rec = useNba<Rec>("record.json");
  const due = useNba<NbaDue>("due.json");
  const cor = useNba<NbaCorrelation>("correlation.json");
  const c = conf.data?.props;
  return (
    <div className="space-y-5">
      <PageTitle kicker="NBA" title="Track record" />
      {(markets.isLoading || conf.isLoading) && <Card><LoadingBlock rows={6} className="p-5" /></Card>}

      <Card>
        <CardHeader title="Live record" subtitle="Each day's leans are saved before tip-off and graded after the games" />
        <CardBody>
          {rec.data && !rec.data.picks && <p className="text-sm text-muted">{rec.data.empty_reason}</p>}
          {rec.data?.tiers && (<>
            <p className="mb-3 text-sm text-muted">{rec.data.picks.toLocaleString()} graded leans over {rec.data.days} days ({rec.data.first_date} to {rec.data.last_date}).
              {rec.data.vs_books?.picks ? ` Against the books (our chance 3+ pts above the best price): ${rec.data.vs_books.wins}/${rec.data.vs_books.picks}, ${rec.data.vs_books.units >= 0 ? "+" : ""}${num(rec.data.vs_books.units, 1)} units.` : ""}</p>
            <TierTable tiers={rec.data.tiers} />
          </>)}
        </CardBody>
      </Card>

      {rec.data?.post_game && rec.data.post_game.n > 0 && <PostGameCard pg={rec.data.post_game} check={rec.data.projection_check ?? []} />}

      {c && (
        <Card>
          <CardHeader title="Backtest: how often each band hit" subtitle={`Every game since ${c.first_season - 1}-${String(c.first_season).slice(2)}, predicted only from games before it, at each player's usual line`} />
          <CardBody className="space-y-4">
            <TierTable tiers={c.tiers} />
            <div className="grid gap-3 sm:grid-cols-2">
              {(["under", "over"] as const).map((s) => {
                const strong = c.by_side[s].filter((t) => t.lo >= 0.6);
                const n = strong.reduce((a, t) => a + t.n, 0), k = strong.reduce((a, t) => a + t.hits, 0);
                return <div key={s} className="rounded-lg border border-line p-3 text-sm"><div className="label">{s === "under" ? "Unders" : "Overs"} at 6.0+</div>
                  <div className="text-lg font-semibold">{pct(n ? k / n : null, 1)} <span className="text-xs font-normal text-muted">of {n.toLocaleString()}</span></div></div>;
              })}
            </div>
          </CardBody>
        </Card>
      )}

      {markets.data && (
        <Card>
          <CardHeader title="Model checks by market" subtitle="A market shows over/under scores only after passing every check on games it never saw" />
          <TableWrap><table className="w-full text-sm">
            <thead><tr><Th>Market</Th><Th>Status</Th><Th className="text-right">Test games</Th><Th className="text-right">Typical miss</Th><Th className="text-right">His average misses by</Th><Th className="text-right">6.0+ leans hit</Th><Th>Checks</Th></tr></thead>
            <tbody>{markets.data.markets.map((m) => (
              <tr key={m.market} className="border-b border-line/60 align-top">
                <Td className="font-medium">{m.label}</Td>
                <Td>{m.validated ? <Badge tone="accent">Validated</Badge> : <Badge tone="warn">Research</Badge>}</Td>
                <Td className="text-right">{m.test_rows.toLocaleString()}</Td>
                <Td className="text-right">{num(m.mae, 2)}</Td><Td className="text-right text-muted">{num(m.baseline_mae, 2)}</Td>
                <Td className="text-right font-semibold">{pct(m.lean_hit_rate, 1)} <span className="text-xs font-normal text-muted">({m.lean_n.toLocaleString()})</span></Td>
                <Td><ul className="space-y-0.5 text-xs">{Object.entries(m.checks).map(([k, v]) => (
                  <li key={k} className={cn("flex items-center gap-1", v ? "text-muted" : "text-danger")}>{v ? <Check className="h-3 w-3 text-accent" /> : <X className="h-3 w-3" />}{CHECKS[k] ?? k}</li>
                ))}</ul></Td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        </Card>
      )}

      {c?.by_market && (
        <Card>
          <CardHeader title="Strong leans by market" />
          <TableWrap><table className="w-full text-sm">
            <thead><tr><Th>Market</Th><Th className="text-right">6.0+ leans</Th><Th className="text-right">Hit</Th><Th className="text-right">Unders</Th><Th className="text-right">Overs</Th></tr></thead>
            <tbody>{c.by_market.map((m) => (
              <tr key={m.market} className="border-b border-line/60"><Td>{m.label}</Td><Td className="text-right">{m.strong_n.toLocaleString()}</Td>
                <Td className="text-right font-semibold">{pct(m.strong_rate, 1)}</Td><Td className="text-right">{pct(m.unders_strong_rate, 1)}</Td><Td className="text-right">{pct(m.overs_strong_rate, 1)}</Td></tr>
            ))}</tbody>
          </table></TableWrap>
        </Card>
      )}

      {due.data && Object.keys(due.data.markets).length > 0 && (
        <Card>
          <CardHeader title="Due study" subtitle={due.data.rule} />
          <TableWrap><table className="w-full text-sm">
            <thead><tr><Th>Market</Th><Th className="text-right">Due games</Th><Th className="text-right">Beat projection next game</Th><Th className="text-right">Everyone else</Th><Th className="text-right">Went over usual line</Th><Th className="text-right">Model said</Th></tr></thead>
            <tbody>{Object.entries(due.data.markets).map(([k, m]) => (
              <tr key={k} className="border-b border-line/60"><Td>{m.label}</Td><Td className="text-right">{m.n.toLocaleString()}</Td>
                <Td className="text-right font-semibold">{pct(m.beat_projection, 1)}</Td><Td className="text-right text-muted">{pct(m.others_beat_projection, 1)}</Td>
                <Td className="text-right">{pct(m.over_rate, 1)}</Td><Td className="text-right text-muted">{pct(m.model_over, 1)}</Td></tr>
            ))}</tbody>
          </table></TableWrap>
          <CardBody className="text-xs text-muted">Due is a label only. The model's chance already reflects recent games, so nothing is added on top.</CardBody>
        </Card>
      )}

      {cor.data?.validation && (
        <Card>
          <CardHeader title="Parlay simulations: same-game links" subtitle={cor.data.use_correlation ? "In use: beat multiplying chances on unseen months" : "Not in use: did not beat multiplying chances"} />
          <CardBody className="space-y-1 text-sm">
            {cor.data.validation.gate.checks.map((ch) => (
              <div key={ch.check} className="flex items-center gap-2">{ch.pass ? <Check className="h-4 w-4 text-accent" /> : <X className="h-4 w-4 text-danger" />}<span className="text-muted">{ch.check}</span></div>
            ))}
          </CardBody>
        </Card>
      )}
      <Notice tone="info">Basketball research, not betting advice. No pick is guaranteed.</Notice>
    </div>
  );
}
