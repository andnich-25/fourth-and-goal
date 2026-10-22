import { num, pct } from "@/lib/format";
import { Card, CardBody, CardHeader, Notice, Stat, TableWrap, Td, Th } from "@/components/ui";

export type SchemeSplit = { split: string; label: string; plays: number; epa: number; epa_shrunk: number; league_epa: number; success: number;
  league_success: number; diff: number; repeat: string | null; rank?: number; of?: number; season: number };
export type SchemeRate = { label: string; value: number; league: number; plays: number; repeat: string | null };
export type SchemeMatch = { scheme: string; defense_rate: number; league_rate: number; label: string; offense_epa: number; league_epa: number;
  diff: number; offense_rank: number | null; of: number | null; plays: number; repeat: string | null; edge: "offense" | "defense" | "even" };
export type TeamSchemes = {
  through_week: number; charted_weeks: number[]; coverage_season: number | null; coverage_note: string | null; method: string; repeat_season: number | null;
  league_coverage_mix: Record<string, number>; opponent: string | null;
  defense: { rates: Record<string, SchemeRate>; splits: SchemeSplit[]; weak_spots: SchemeSplit[]; strengths: SchemeSplit[]; coverage_mix: Record<string, number> };
  offense: { splits: SchemeSplit[] } | null;
  opponent_attack: SchemeMatch[]; own_attack: SchemeMatch[];
};

const RATE_ORDER = ["blitz_rate", "rushers", "pressure_rate", "man_rate", "zone_rate", "stacked_box_rate", "light_box_rate"];
const SHORT: Record<string, string> = { blitz_rate: "Blitz rate", rushers: "Pass rushers", pressure_rate: "Sack or hit", man_rate: "Man coverage",
  zone_rate: "Zone coverage", stacked_box_rate: "8+ in the box", light_box_rate: "6 or fewer in box" };
const epa = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
const holds = (r: string | null) => (r === "repeats" ? "Holds up" : r === "somewhat repeats" ? "Somewhat" : r === "mostly noise" ? "Mostly noise" : "Too few plays");
const holdsTone = (r: string | null) => (r === "repeats" ? "text-ok" : r === "somewhat repeats" ? "text-fg" : "text-muted");

function MatchList({ title, rows, offense, defense }: { title: string; rows: SchemeMatch[]; offense: string; defense: string }) {
  return (
    <div>
      <div className="label mb-2">{title}</div>
      {rows.length ? (
        <ul className="space-y-2 text-sm">
          {rows.map((m) => (
            <li key={m.scheme} className="rounded-lg border border-line p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{defense} {m.scheme === "Average pass rushers" ? "rushes extra" : `runs ${m.scheme.replace(/ \(.*\)$/, "").toLowerCase()}`}</span>
                <span className={m.edge === "offense" ? "text-ok" : m.edge === "defense" ? "text-danger" : "text-muted"}>
                  {m.edge === "offense" ? `Edge ${offense}` : m.edge === "defense" ? `Edge ${defense}` : "Even"}
                </span>
              </div>
              <div className="mt-1 text-muted">
                {pct(m.defense_rate)} of the time (league {pct(m.league_rate)}). {offense} on {m.label.toLowerCase()}: {epa(m.offense_epa)} EPA per play
                vs league {epa(m.league_epa)}{m.offense_rank ? `, ${m.offense_rank} of ${m.of}` : ""} ({m.plays} plays). {holds(m.repeat)} from week to week.
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">Nothing {defense} leans on stands out against this offense.</p>}
    </div>
  );
}

export function SchemesSection({ s, team, season, week }: { s: TeamSchemes; team: string; season: number; week: number }) {
  const d = s.defense;
  const shells = Object.entries(d.coverage_mix).sort((a, b) => b[1] - a[1]);
  const splits = [...d.splits].filter((x) => x.plays >= 15).sort((a, b) => b.diff - a.diff);
  const weak = new Set(d.weak_spots.map((x) => x.split));
  const lastCharted = s.charted_weeks[s.charted_weeks.length - 1];
  return (
    <>
      <Card>
        <CardHeader title="What they run" subtitle={`Season so far, charting through Week ${lastCharted ?? "—"}. Hover a number for whether it holds up.`} />
        <CardBody className="grid grid-cols-2 gap-5 sm:grid-cols-4 lg:grid-cols-7">
          {RATE_ORDER.filter((k) => d.rates[k]).map((k) => {
            const r = d.rates[k];
            const cov = k === "man_rate" || k === "zone_rate";
            return <Stat key={k} label={SHORT[k]} value={k === "rushers" ? num(r.value) : pct(r.value)}
              sub={<>League {k === "rushers" ? num(r.league) : pct(r.league)}{cov && s.coverage_season ? ` · ${s.coverage_season}` : ""}</>} hint={`${r.label}. ${holds(r.repeat)} from week to week.`} />;
          })}
        </CardBody>
        {shells.length > 0 && (
          <CardBody className="border-t border-line">
            <div className="label mb-3">Coverage shells on dropbacks{s.coverage_season ? ` (${s.coverage_season})` : ""}</div>
            <div className="space-y-1.5">
              {shells.map(([k, v]) => {
                const lg = s.league_coverage_mix[k] ?? 0;
                return (
                  <div key={k} className="grid grid-cols-[110px_1fr_88px] items-center gap-3 text-sm">
                    <span>{k}</span>
                    <div className="relative h-2.5 rounded bg-raised">
                      <div className="absolute inset-y-0 left-0 rounded bg-accent" style={{ width: `${Math.min(100, v * 200)}%` }} />
                      <div className="absolute inset-y-[-3px] w-0.5 bg-fg/60" style={{ left: `${Math.min(100, lg * 200)}%` }} title={`League ${pct(lg)}`} />
                    </div>
                    <span className="num text-right text-muted">{pct(v)} <span className="text-xs">vs {pct(lg)}</span></span>
                  </div>
                );
              })}
            </div>
          </CardBody>
        )}
      </Card>

      {s.opponent && (
        <Card>
          <CardHeader title={`Week ${week} scheme matchup vs ${s.opponent}`} subtitle="What each defense leans on, and how the other offense has done against it" />
          <CardBody className="grid gap-5 lg:grid-cols-2">
            <MatchList title={`${s.opponent} offense vs the ${team} defense`} rows={s.opponent_attack} offense={s.opponent} defense={team} />
            <MatchList title={`${team} offense vs the ${s.opponent} defense`} rows={s.own_attack} offense={team} defense={s.opponent} />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="How offenses have attacked them" subtitle="EPA per play allowed in each situation, worst first. Highlighted rows are their weak spots." />
        <TableWrap>
          <table className="w-full">
            <thead><tr><Th>Situation</Th><Th className="text-right">Plays</Th><Th className="text-right">EPA allowed</Th><Th className="text-right">League</Th><Th className="text-right">Success</Th><Th className="text-right" title="1 = allows the most">Rank</Th><Th title={`Does a defense's number in this situation repeat from odd to even weeks? Checked on ${s.repeat_season ?? "last season"}.`}>Holds up?</Th></tr></thead>
            <tbody>
              {splits.map((x) => (
                <tr key={x.split} className={weak.has(x.split) ? "bg-danger/5" : undefined}>
                  <Td>{x.label}{x.season !== season && <span className="ml-1 text-xs text-muted">({x.season})</span>}</Td>
                  <Td className="text-right text-muted">{x.plays}</Td>
                  <Td className={`text-right font-medium ${x.diff > 0.02 ? "text-danger" : x.diff < -0.02 ? "text-ok" : ""}`}>{epa(x.epa_shrunk)}</Td>
                  <Td className="text-right text-muted">{epa(x.league_epa)}</Td>
                  <Td className="text-right">{pct(x.success)}</Td>
                  <Td className="text-right text-muted">{x.rank ? `${x.rank}/${x.of}` : "—"}</Td>
                  <Td className={`text-xs ${holdsTone(x.repeat)}`}>{holds(x.repeat)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Card>

      <Notice tone="info" title="How to read this">
        Scheme habits (blitz rate, man or zone, box counts) carry over from week to week, so they are reliable. How a defense does in one
        situation mostly does not: on {s.repeat_season ?? "last season"}'s data only a few situations held up from odd to even weeks, and
        the rest are labelled "Mostly noise". {s.coverage_note} {s.method} None of this changes the picks.
      </Notice>
    </>
  );
}
