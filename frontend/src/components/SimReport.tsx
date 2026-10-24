/* Every NFL game's simulation, frozen at kickoff and run again after the final with what really happened (engine/simreview.py). */
import { Repeat } from "lucide-react";
import { num, pct } from "@/lib/format";
import { Badge, Card, CardBody, CardHeader, Stat, TableWrap, Td, Th } from "@/components/ui";
import { useLiveRecord } from "@/components/LiveRecord";

type Level = "pregame" | "played" | "volume" | "roles" | "efficiency";
type MarketRow = { market: string; label: string; n: number; bias: number; in_range: number; miss: Record<Level, number>; share: Record<Exclude<Level, "pregame">, number>; chance: number };
type InputRow = { input: string; label: string; unit: string; n: number; bias: number; typical_miss: number; last_week_bias: number | null; last_week_n: number; clear: boolean;
  correction: { key: string; value: number | null; adopted: boolean; gain?: number | null } | null };
type TeamRow = { team: string; attempts: number; exp_attempts: number; carries: number; exp_carries: number; points: number; implied: number | null; sat_out: string[] };
export type SimReport = {
  available: boolean; empty_reason?: string; games?: number; pending?: number; weeks?: [number, number][]; last_week?: { season: number; week: number };
  levels?: { key: Level; label: string }[]; markets?: MarketRow[]; markets_last_week?: MarketRow[]; inputs?: InputRow[]; notes?: string[];
  corrections?: { in_use: Record<string, number>; tests: Record<string, { gain: number; gain_ci90: [number, number]; adopt: boolean; n: number }> };
  game_cards?: { game_id: string; matchup: string; teams: TeamRow[]; notes: string[] }[];
  biggest_misses?: { player: string; team: string; market: string; pre: number; actual: number; cause: string }[];
};

const LEVELS: Level[] = ["pregame", "played", "volume", "roles", "efficiency"];
const HEAD: Record<Level, string> = { pregame: "Pregame", played: "+ who played", volume: "+ volume", roles: "+ roles", efficiency: "+ efficiency" };
const CORR: Record<string, string> = { pass_adj: "Team passes", rush_adj: "Team runs", catch_adj: "Catch rate", ypt_adj: "Yards per target", ypc_adj: "Yards per carry" };
const signed = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v), d)}`);

function MarketTable({ rows }: { rows: MarketRow[] }) {
  return (
    <TableWrap>
      <table className="w-full [&_td]:px-1.5 [&_th]:px-1.5 [&_th]:tracking-normal sm:[&_td]:px-3 sm:[&_th]:px-3">
        <thead><tr><Th>Stat</Th>{LEVELS.map((l) => <Th key={l} className="text-right">{HEAD[l]}</Th>)}<Th className="text-right" title="Actual minus the pregame sim: positive means players beat it">Ran</Th></tr></thead>
        <tbody>{rows.map((m) => (
          <tr key={m.market} className="border-b border-line/60">
            <Td className="whitespace-normal">{m.label} <span className="text-xs text-muted">({m.n})</span></Td>
            {LEVELS.map((l, i) => <Td key={l} className={i ? "text-right text-muted" : "text-right font-semibold"}>{num(m.miss[l], 1)}</Td>)}
            <Td className="text-right text-muted">{signed(m.bias)}</Td>
          </tr>))}</tbody>
      </table>
    </TableWrap>
  );
}

export function SimReportCard() {
  const d = useLiveRecord().data?.sim_report;
  if (!d) return null;
  const inputs = d.inputs ?? [];
  const flagged = inputs.filter((x) => x.clear);
  return (
    <Card>
      <CardHeader icon={<Repeat className="h-4 w-4 text-accent" />} title="Post-game re-sims"
        subtitle="Every game's 5,000-run simulation is frozen at kickoff, then run again after the final with what really happened, one layer at a time, to show which pregame input was off." />
      <CardBody className="space-y-5 text-sm">
        {!d.available ? <p className="text-muted">{d.empty_reason}{d.pending ? ` ${d.pending} frozen games are waiting on box scores.` : ""}</p> : <>
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
            <Stat label="Games re-simulated" value={d.games?.toLocaleString() ?? "0"} sub={d.pending ? `${d.pending} waiting on box scores` : `through Week ${d.last_week?.week}`} />
            {(["rec_yards", "rush_yards"] as const).map((k) => {
              const m = d.markets?.find((x) => x.market === k);
              return m ? <Stat key={k} label={`${m.label} miss`} value={`${num(m.miss.pregame, 1)} → ${num(m.miss.roles, 1)}`} sub="pregame → with real usage" /> : null;
            })}
            <Stat label="Inputs running off" value={flagged.length ? String(flagged.length) : "None"} sub={flagged.length ? flagged.map((x) => x.label).join(", ") : "every input within its normal range"} />
          </div>

          {!!d.notes?.length && <ul className="list-disc space-y-0.5 pl-5 text-muted">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>}

          <div>
            <div className="font-medium">Where the misses came from</div>
            <p className="mt-0.5 text-xs text-muted">Typical miss of the simulated median. Each column adds one real input on top of the last: who played, the team's passes, runs and score, each player's share of the targets and carries, then his catch rate and yards per catch or carry. What is left in the last column is plain chance.</p>
            <div className="mt-2"><MarketTable rows={d.markets ?? []} /></div>
          </div>

          <div>
            <div className="font-medium">Pregame inputs vs what happened</div>
            <TableWrap className="mt-2">
              <table className="w-full [&_td]:px-1.5 [&_th]:px-1.5 [&_th]:tracking-normal sm:[&_td]:px-3 sm:[&_th]:px-3">
                <thead><tr><Th>Input</Th><Th className="text-right" title="Actual minus pregame, averaged">Bias</Th><Th className="text-right">Week {d.last_week?.week}</Th><Th className="text-right">Typical miss</Th><Th>Next sims</Th></tr></thead>
                <tbody>{inputs.map((x) => (
                  <tr key={x.input} className="border-b border-line/60">
                    <Td className="whitespace-normal">{x.label} <span className="text-xs text-muted">({x.n})</span></Td>
                    <Td className={x.clear ? "text-right font-semibold text-warn" : "text-right"}>{signed(x.bias)} <span className="text-xs font-normal text-muted">{x.unit}</span></Td>
                    <Td className="text-right text-muted">{signed(x.last_week_bias)}</Td>
                    <Td className="text-right text-muted">{num(x.typical_miss, 1)}</Td>
                    <Td>{!x.correction ? <span className="text-xs text-muted">watched</span>
                      : x.correction.adopted ? <Badge tone="accent">corrected{x.correction.value != null ? ` ×${num(x.correction.value, 3)}` : ""}</Badge>
                      : <span className="text-xs text-muted">tested, not used yet</span>}</Td>
                  </tr>))}</tbody>
              </table>
            </TableWrap>
            <p className="mt-1 text-xs text-muted">Highlighted: the average gap is clearly away from zero (30+ cases). Team passes and runs are corrected every week from the newest games; catch rate, yards per target and yards per carry are corrected only once that correction beats no correction on past weeks (rechecked every update).</p>
          </div>

          {!!d.game_cards?.length && (
            <div>
              <div className="font-medium">Week {d.last_week?.week} games</div>
              <div className="mt-2 grid gap-3 md:grid-cols-2">{d.game_cards.map((g) => (
                <div key={g.game_id} className="rounded-lg border border-line p-3">
                  <div className="flex items-baseline justify-between gap-2"><span className="font-medium">{g.matchup}</span>
                    <span className="text-xs text-muted">{g.teams.map((t) => `${t.team} ${t.points}`).join(" · ")}</span></div>
                  <div className="mt-1 text-xs text-muted">{g.teams.map((t) => `${t.team}: ${t.attempts} passes (sim ${num(t.exp_attempts, 0)}), ${t.carries} runs (sim ${num(t.exp_carries, 0)})`).join(" · ")}</div>
                  {g.notes.length ? <ul className="mt-1.5 list-disc space-y-0.5 pl-5">{g.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                    : <p className="mt-1.5 text-muted">Inputs close to the pregame sim.</p>}
                </div>))}</div>
            </div>)}

          {!!d.biggest_misses?.length && (
            <div>
              <div className="font-medium">Biggest misses in Week {d.last_week?.week}</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{d.biggest_misses.map((x) => (
                <li key={`${x.player}-${x.market}`}>{x.player} ({x.team}) {x.market.replace(/_/g, " ")}: sim {num(x.pre, 0)}, actual {num(x.actual, 0)}, mostly {x.cause}</li>))}</ul>
            </div>)}

          {d.corrections?.in_use && (
            <p className="text-xs text-muted">In use for the next simulations: {Object.entries(d.corrections.in_use).filter(([k]) => CORR[k]).map(([k, v]) => `${CORR[k]} ×${num(v, 3)}`).join(", ")}.
              {Object.entries(d.corrections.tests ?? {}).length ? ` Efficiency tests on recent weeks: ${Object.entries(d.corrections.tests).map(([k, t]) => `${CORR[k]} ${t.adopt ? "helped" : "did not help yet"}`).join(", ")}.` : ""}
              {" "}{pct(d.markets?.length ? d.markets.reduce((a, m) => a + m.in_range * m.n, 0) / d.markets.reduce((a, m) => a + m.n, 0) : null, 0)} of results landed inside the sim's 8-in-10 range.</p>)}
        </>}
      </CardBody>
    </Card>
  );
}
