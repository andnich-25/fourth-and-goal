import { Link } from "react-router-dom";
import { CircleDollarSign, Hourglass } from "lucide-react";
import { num, pct } from "@/lib/format";
import { useNba, type MarketReport, type NbaConfidence, type NbaStatus } from "@/lib/nba";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody } from "@/components/ui";
import { TierTable } from "./NbaRecord";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card><CardBody className="space-y-2 text-sm leading-relaxed"><h2 className="font-semibold text-fg">{title}</h2><div className="space-y-2 text-muted">{children}</div></CardBody></Card>;
}

export default function NbaHow() {
  const st = useNba<NbaStatus>("status.json");
  const markets = useNba<{ markets: MarketReport[] }>("markets.json");
  const conf = useNba<NbaConfidence>("confidence.json");
  const h = st.data?.history;
  return (
    <div className="space-y-4">
      <PageTitle kicker="NBA" title="How it works" />
      <Section title="The scores out of 10">
        <p>Every player gets an Under score and an Over score for the line shown. The score is the model's chance of that side, so 7.2 means a 72% chance and the other side is 2.8. The bigger number is the lean.
          Bands: <b>Toss-up</b> under 5.5, <b>Lean</b> 5.5 to 6.0, <b>Solid</b> 6.0 to 6.5, <b>Strong</b> 6.5 and up. Each band shows how often it actually hit on games the model never saw.</p>
        {conf.data?.props && <TierTable tiers={conf.data.props.tiers} />}
      </Section>
      <Section title="Where the numbers come from">
        <p>Box scores for every game since {h ? `${h.first_season - 1}-${String(h.first_season).slice(2)}` : "2018-19"} ({h ? h.games.toLocaleString() : "—"} games, {h ? h.player_games.toLocaleString() : "—"} player-games), refreshed every morning, plus the ESPN injury report. Players listed Out are faded and never picked.</p>
        <p>For each player and market the model looks only at games before tonight: recent and longer-run minutes, how often he starts, his per-minute rate for the stat and his shot volume, both teams' pace, how much the opponent allows to his position compared with the league, rest days and home or away.
          A gradient-boosted model turns that into an average, and a negative binomial spread around it gives the chance of any line.</p>
        <p><b>Rosters and team scoring.</b> Each morning's ESPN rosters decide who plays for whom, so a player who changed teams is projected for his new team before he has played for it.
          Because each player is projected from his own history, a team that adds scorers can project to more points than it ever scores. When a team's rotation adds up high against its usual scoring, every player's points are scaled down (and up when it adds up low).
          {st.data?.team_check?.plain && st.data.team_check.adjusted && <> On {st.data.team_check.test_seasons?.join(" and ")} games it never saw, this raised 6.0+ points leans from {pct(st.data.team_check.plain.strong_hit, 1)} to {pct(st.data.team_check.adjusted.strong_hit, 1)}{st.data.team_check.use ? "" : ", not enough to switch it on"}.</>}</p>
        <p><b>Recent seasons count most.</b> A game's weight halves every {st.data?.recency_half_life_seasons ?? 2} seasons, so last season counts about twice as much as two seasons before it, and the current season the most.</p>
      </Section>
      <Section title="How it is tested">
        <p>Walk-forward: starting in 2021-22, the model is rebuilt at the start of each month from earlier games only and then predicts that month's games. The spread and the final over/under adjustment are also learned only from earlier months.
          A market shows scores only if, on those unseen games, it beats the player's own average on accuracy, makes better over/under calls, gives honest chances (within 2.5 points), and holds up last season.</p>
        {markets.data && <ul className="list-disc pl-5">{markets.data.markets.map((m) => (
          <li key={m.market}><b className="text-fg">{m.label}</b>: {m.validated ? "validated" : "research only"}; typical miss {num(m.mae, 1)} vs {num(m.baseline_mae, 1)} for his average; 6.0+ leans hit {pct(m.lean_hit_rate, 0)} of {m.lean_n.toLocaleString()}.</li>
        ))}</ul>}
      </Section>
      <Section title="Lines">
        <p>When sportsbook prop lines are loaded, the book line is used. Otherwise the line is the player's usual line: the median of his last 10 games, rounded down to a half point. You can type any line on the props page and the scores update.
          Historical sportsbook lines are not freely available, so the backtest uses the usual line.</p>
      </Section>
      <Section title="Signals">
        <p className="flex gap-2"><CircleDollarSign className="mt-0.5 h-4 w-4 shrink-0 text-accent" /><span><b className="text-fg">Edge</b>: our chance of the lean beats the chance implied by the best book price by 3+ points. Appears only when book prices are loaded.</span></p>
        <p className="flex gap-2"><Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-warn" /><span><b className="text-fg">Due</b>: he finished under his projection in each of his last 4 games while playing 20+ minutes. The <Link to="/nba/record" className="text-accent hover:underline">track record</Link> shows how such players did next time; it is a label, not an extra boost.</span></p>
      </Section>
      <Section title="Parlays">
        <p>The parlay builder simulates 40,000 games. Legs in the same game can move together (a player's points and his points + rebounds + assists, teammates sharing shots); how strongly was learned from past games and is used only if it beat simply multiplying chances on unseen months.</p>
      </Section>
      <p className="text-xs text-muted">Basketball research, not betting advice. No pick is guaranteed.</p>
    </div>
  );
}
