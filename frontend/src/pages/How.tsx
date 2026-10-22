import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, CircleDollarSign, Hourglass } from "lucide-react";
import { api } from "@/lib/api";
import { useConfidence } from "@/lib/confidence";
import { chicago, num, pct } from "@/lib/format";
import { useLinkSuffix } from "@/lib/state";
import type { ProbMetrics } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody, CardHeader, Stat, TableWrap, Td, Th } from "@/components/ui";
import { TierTable } from "./Backtest";
import { DUE_GAP, useDueStudy } from "@/lib/signals";

type Summary = { available: boolean; created_at: string; test_weeks: [number, number][]; overall: Record<string, ProbMetrics>; gate: { promoted: string | null } };
type OddsRecord = { picks: number; wins?: number; win_rate?: number | null; avg_implied?: number | null; units?: number; empty_reason?: string };
type ParlayModel = { use_correlation: boolean; created_at?: string };

const MODEL_NAME: Record<string, string> = { "fg-logit-1": "logistic regression", "fg-gbm-1": "gradient boosting", "fg-structural-1": "structural model" };

function Term({ name, children }: { name: string; children: React.ReactNode }) {
  return <div><dt className="text-sm font-semibold">{name}</dt><dd className="mt-0.5 text-sm text-muted">{children}</dd></div>;
}

export default function HowPage() {
  const suffix = useLinkSuffix();
  const s = useQuery({ queryKey: ["bt-summary"], queryFn: () => api.get<Summary>("/backtest/summary") });
  const rec = useQuery({ queryKey: ["odds-record"], queryFn: () => api.get<OddsRecord>("/odds/record") });
  const cor = useQuery({ queryKey: ["parlay-model"], queryFn: () => api.get<ParlayModel>("/parlay/model") });
  const conf = useConfidence();
  const d = s.data?.available ? s.data : undefined;
  const promoted = d?.gate.promoted ?? undefined;
  const m = promoted ? d?.overall[promoted] : undefined;
  const base = d?.overall["baseline-shrunk-player-rate"];
  const weeks = d?.test_weeks ?? [];
  const p = conf.data?.props;
  const r = rec.data;
  const strongUnder = p?.by_side?.under.find((t) => t.tier === "Strong");
  const due = useDueStudy();
  const dueBin = due.data?.bins?.find((b) => b.lo >= DUE_GAP);

  return (
    <div className="space-y-5">
      <PageTitle kicker="Proof" title="How it works" />

      <Card>
        <CardHeader icon={<BookOpen className="h-4 w-4 text-accent" />} title="The short version" />
        <CardBody className="space-y-3 text-sm leading-relaxed">
          <p>Every week the site estimates, for each skill player, the chance he scores an anytime touchdown and the chance he goes over or under
            each prop line. Those chances come from models trained on every game since 2018, with the touchdown model counting the last two seasons most.</p>
          <p>Nothing is shown until it passes a test on weeks the model never saw: each past week is predicted using only the games before it,
            then graded. The numbers below are those results, refreshed every time the model retrains.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What the numbers on each pick mean" />
        <CardBody>
          <dl className="grid gap-4 md:grid-cols-2">
            <Term name="Chance">The model's probability that the bet hits. A 40% TD chance means players given about 40% have scored about 40% of the time in testing.</Term>
            <Term name="Confidence out of 10">On the props page each player gets an under score and an over score for the line. The score is the chance times 10, so 8.7 under means an 87% chance and the over is 1.3. They always add to 10, and the bigger one is the lean.</Term>
            <Term name="Confidence tier">Strong, Solid, Lean or Long shot / Coin flip. A plain grouping of the chance, with the real hit rate for that group shown beside it.</Term>
            <Term name="Edge">Our chance minus the chance implied by the best US sportsbook price. A positive edge means the price pays more than the risk deserves. Shown only when prices are loaded.</Term>
            <Term name="Line">The book line when books offer one. Otherwise the player's usual line: his recent median, rounded to a half point.</Term>
            <Term name="Projection and range">For props, the middle outcome and the range he lands in 8 times out of 10.</Term>
            <Term name="Reasons">Why a pick ranks where it does: the opponent's defense against that position compared with the league, recent form, role and the team's scoring outlook.</Term>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Symbols next to player names" />
        <CardBody className="space-y-4 text-sm">
          <div className="flex gap-3">
            <CircleDollarSign className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
            <div><div className="font-semibold">Edge</div>
              <p className="text-muted">Our anytime-TD chance beats the chance implied by the best price at any US book by 3 points or more. Example: we say 40%, the best price is +200 (33% implied), so the edge is +7 points. Only appears once the week's prices are loaded. These picks are graded every week in the against-the-books record below.</p></div>
          </div>
          <div className="flex gap-3">
            <Hourglass className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
            <div><div className="font-semibold">Due</div>
              <p className="text-muted">He has scored at least 1.5 fewer TDs this season than his carries and targets predicted (expected TDs, from how often touches at each spot on the field have turned into scores since 2018), over 3+ games.
                {dueBin?.hit_rate != null && dueBin.season_td_rate != null && dueBin.avg_chance != null && <> Tested on {due.data?.test?.weeks} unseen weeks: {dueBin.n.toLocaleString()} due players went on to score in {pct(dueBin.hit_rate, 0)} of games, far above their {pct(dueBin.season_td_rate, 0)} rate so far, and close to the {pct(dueBin.avg_chance, 0)} the model gave them.</>}
                {" "}So being due is real, and the model's chance already includes it. Adding the gap on top again made predictions slightly worse, so it is not double-counted.</p></div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What goes into the models" />
        <CardBody className="grid gap-6 md:grid-cols-2 text-sm">
          <div>
            <div className="font-semibold">Anytime touchdown</div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
              <li>Opportunity: carries, targets, and red-zone, inside-10 and inside-5 touches per game</li>
              <li>Expected touchdowns from where his touches happen, and his share of the team's</li>
              <li>Snap share and how many games he has played this season, plus team changes</li>
              <li>The team's expected points from the betting spread and total</li>
              <li>How the opponent's defense has allowed touchdowns to his position, from games before this week</li>
              <li>His position and long-run scoring rate, shrunk toward average when the sample is small</li>
            </ul>
          </div>
          <div>
            <div className="font-semibold">Props (yards, catches, attempts, TDs, picks)</div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
              <li>His season average, median, last 3 games and current-season form</li>
              <li>Volume: targets, carries or attempts, and his share of the team's</li>
              <li>Efficiency: yards per target, carry or attempt, catch rate and completion rate</li>
              <li>How the opponent has allowed that stat compared with the league</li>
              <li>Game script: team and opponent expected points, total and spread, home or away</li>
              <li>A spread of outcomes per market, so the same model prices the over and the under</li>
            </ul>
          </div>
        </CardBody>
        <CardBody className="border-t border-line text-sm text-muted">
          Parlays are simulated 40,000 times. {cor.data?.use_correlation ? "Legs from the same game move together the way they have historically (for example a QB's yards and his receiver's), because that tested better than treating them as independent." : "Legs are treated as independent, because a same-game correlation did not test better."}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Live ratings" subtitle={d ? `Latest retrain ${chicago(d.created_at)} · ${weeks.length} unseen weeks, ${weeks[0]?.join(" week ")} to ${weeks.at(-1)?.join(" week ")}` : "Loading the latest test run"} />
        <CardBody className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <Stat label="TD model in use" value={promoted ? MODEL_NAME[promoted] ?? promoted : "None"} sub="picked by the promotion test" />
          <Stat label="Accuracy (Brier, lower is better)" value={num(m?.brier, 4)} sub={base ? `vs ${num(base.brier, 4)} for a player's own TD rate` : undefined} />
          <Stat label="Ranking skill (AUC)" value={num(m?.auc, 3)} sub={base ? `vs ${num(base.auc, 3)} baseline; 0.5 is a coin flip` : undefined} />
          <Stat label="Calibration error" value={m?.ece != null ? `${num(m.ece * 100, 1)} pts` : "–"} sub="average gap between chance and hit rate" />
        </CardBody>
        <CardBody className="grid gap-6 border-t border-line lg:grid-cols-2">
          {conf.data?.td && <TierTable title="Anytime touchdown" sub={`Every pick on ${conf.data.td.weeks} unseen weeks`} tiers={conf.data.td.tiers} />}
          {p && <TierTable title="Player props (side we favored)" sub={p.note} tiers={p.tiers} />}
        </CardBody>
        <CardBody className="border-t border-line text-sm">
          <span className="font-semibold">Against the books: </span>
          <span className="text-muted">{r && r.picks ? `${r.wins} of ${r.picks} value picks won (${pct(r.win_rate, 0)}) against ${pct(r.avg_implied, 0)} implied by the price, ${r.units! >= 0 ? "+" : ""}${num(r.units, 1)} units.`
            : "Graded from the weekly price pulls. Past sportsbook prices aren't available for free, so this record starts this season and grows each week."}</span>
        </CardBody>
      </Card>

      {p?.by_side && (
        <Card>
          <CardHeader title="Overs and unders, tracked separately" subtitle="So you can see the model is as honest about players falling short as about players going over" />
          <CardBody className="grid gap-6 md:grid-cols-2">
            <TierTable title="Unders" sub="How often the under hit" tiers={p.by_side.under} />
            <TierTable title="Overs" sub="How often the over hit" tiers={p.by_side.over} />
          </CardBody>
          {p.unders_by_market && (
            <TableWrap>
              <table className="w-full"><thead><tr><Th>Unders by market</Th><Th className="text-right">Picked</Th><Th className="text-right">Our avg chance</Th>
                <Th className="text-right">Hit</Th><Th className="text-right" title="Unders the model gave 65% or more (6.5+ out of 10)">Strong unders hit</Th></tr></thead>
                <tbody>{p.unders_by_market.map((u) => (
                  <tr key={u.market} className="border-b border-line/60"><Td>{u.label}</Td><Td className="text-right text-muted">{u.n.toLocaleString()}</Td>
                    <Td className="text-right text-muted">{pct(u.avg_chance, 0)}</Td><Td className="text-right font-semibold">{pct(u.rate, 0)}</Td>
                    <Td className="text-right">{u.strong_rate != null ? `${pct(u.strong_rate, 0)} of ${u.strong_n.toLocaleString()}` : "–"}</Td></tr>))}</tbody></table>
            </TableWrap>
          )}
          <CardBody className="border-t border-line text-sm text-muted">
            {strongUnder?.rate != null && <>Strong unders have hit {pct(strongUnder.rate, 0)} of {strongUnder.n.toLocaleString()}. </>}
            Each player's under and over confidence for this week, with the matchup reasons, is on the <Link className="text-accent underline" to={`/props${suffix}`}>Player props</Link> page.
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="How it stays honest" />
        <CardBody>
          <dl className="grid gap-4 md:grid-cols-2">
            <Term name="Walk-forward testing">Each past week is predicted with models fit only on earlier games, with defense splits recomputed as of that week. No result leaks into its own prediction.</Term>
            <Term name="Promotion test">A model goes live only if it beats simple baselines on accuracy and ranking and its chances match reality. If none pass, chances are hidden.</Term>
            <Term name="Recent seasons count most">In the touchdown model a game's weight halves every two seasons of age, so the last two seasons carry most of the weight and older seasons still add sample size.</Term>
            <Term name="Top-end correction">High chances are checked against how often high chances actually hit in earlier weeks, so a 55% doesn't quietly mean 45%.</Term>
            <Term name="Weekly retraining">After each week's games the models retrain, re-test and re-promote automatically, and every number on this page updates.</Term>
            <Term name="Limits">Closing spreads and totals are used in testing, which is slightly optimistic. Props are graded at usual lines, not past book lines. No bet is a sure thing.</Term>
          </dl>
        </CardBody>
        <CardBody className="border-t border-line text-sm text-muted">
          Every model, week and pick is on the <Link className="text-accent underline" to={`/backtest${suffix}`}>Track record</Link> page.
        </CardBody>
      </Card>
    </div>
  );
}
