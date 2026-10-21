import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { num } from "@/lib/format";
import { Badge, Card, CardBody, CardHeader, TableWrap, Td, Th } from "@/components/ui";

type Score = { log_loss: number; brier: number; auc: number; top3_policy_hits: number; top3_policy_legs: number; all3_weeks: number; weeks_with_3: number; top5_hits: number; top5_graded: number };
type Tuning = {
  available: boolean; created_at?: string; selection_weeks?: [number, number][]; holdout_weeks?: [number, number][];
  stage_a?: { window: number; prior_season_weight: number; def_shrink_games: number; log_loss: number; top3_policy_hits: number; top3_policy_legs: number }[];
  stage_b?: { added: string; accepted: boolean; log_loss: number; previous: number; all_trials: Record<string, number> }[];
  tuned?: { window: number; prior_season_weight: number; def_shrink_games: number; features: string[]; C: number };
  comparison?: { current: { selection: Score; holdout: Score }; tuned: { selection: Score; holdout: Score }; holdout_ll_gain_ci: [number, number] };
  adopt?: boolean;
};

const FEATURE_NAMES: Record<string, string> = {
  opp_implied_total: "Opponent implied points", spread_for: "Point spread", cur_td_rate: "This-season TD rate", cur_xtd_pg: "This-season xTD/game",
  team_rz_trips_pg: "Team red-zone trips/game", opp_def_rz_td_rate: "Opponent red-zone TD rate allowed", opp_def_rz_trips_pg: "Opponent red-zone trips allowed",
  opp_def_pos_l4_mult: "Opponent TDs allowed to position, last 4", rz_x_def: "Red-zone usage × defense", is_home: "Home field",
};

export function TuningCard() {
  const q = useQuery({ queryKey: ["bt-tuning"], queryFn: () => api.get<Tuning>("/backtest/tuning") });
  const t = q.data;
  if (!t?.available || !t.comparison || !t.tuned || !t.stage_a) return null;
  const cmp = t.comparison;
  const row = (label: string, s: Score) => (
    <tr><Td>{label}</Td><Td className="text-right">{num(s.log_loss, 4)}</Td><Td className="text-right">{num(s.brier, 4)}</Td><Td className="text-right">{num(s.auc, 3)}</Td>
      <Td className="text-right">{s.top3_policy_hits}/{s.top3_policy_legs}</Td><Td className="text-right">{s.all3_weeks}/{s.weeks_with_3}</Td><Td className="text-right">{s.top5_hits}/{s.top5_graded}</Td></tr>
  );
  const last = t.stage_b?.[t.stage_b.length - 1];
  const trials = last ? Object.entries(last.all_trials).sort((a, b) => a[1] - b[1]) : [];
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">Tuning study {t.adopt ? <Badge tone="accent">Adopted</Badge> : <Badge tone="neutral">Not adopted</Badge>}</span>}
        subtitle={`${t.stage_a.length} feature settings and ${Object.keys(t.stage_b?.[0]?.all_trials ?? {}).length} extra metrics tested on 2025 (${t.selection_weeks?.length} weeks), then checked once on ${t.holdout_weeks?.length} untouched 2026 weeks`} />
      <CardBody className="space-y-4 text-sm">
        <p className="text-muted">
          Best setting: last <strong className="text-fg">{t.tuned.window}</strong> games, last season weighted <strong className="text-fg">{t.tuned.prior_season_weight}</strong>,
          defense shrinkage <strong className="text-fg">{t.tuned.def_shrink_games}</strong> games, regularisation C={t.tuned.C}.
          {t.adopt ? " It was at least as good on the untouched 2026 weeks, so it now runs the rankings." : " It did not hold up on the untouched 2026 weeks, so the previous setting stays."}
        </p>
        <TableWrap>
          <table className="w-full"><thead><tr><Th /><Th className="text-right">Log loss</Th><Th className="text-right">Brier</Th><Th className="text-right">AUC</Th><Th className="text-right">Top 3 legs</Th><Th className="text-right">All 3 hit</Th><Th className="text-right">Top 5</Th></tr></thead>
            <tbody>
              {row("Previous · 2025 (tuning set)", cmp.current.selection)}{row("Tuned · 2025 (tuning set)", cmp.tuned.selection)}
              {row("Previous · 2026 holdout", cmp.current.holdout)}{row("Tuned · 2026 holdout", cmp.tuned.holdout)}
            </tbody></table>
        </TableWrap>
        <p className="text-xs text-muted">Lower log loss and Brier are better. Holdout log-loss gain 95% CI: {num(cmp.holdout_ll_gain_ci[0], 4)} to {num(cmp.holdout_ll_gain_ci[1], 4)} (positive favours the tuned model).</p>
        {trials.length > 0 && (
          <div>
            <div className="label mb-1">Extra metrics tried (log loss when added; lower is better, needs a 0.0003 gain to be kept)</div>
            <ul className="grid gap-x-6 sm:grid-cols-2">{trials.map(([k, v]) => <li key={k} className="flex justify-between"><span className="text-muted">{FEATURE_NAMES[k] ?? k}</span><span>{num(v, 4)}</span></li>)}</ul>
            <p className="mt-1 text-xs text-muted">Baseline before adding: {num(last?.previous, 4)}. {t.tuned.features.length > 24 ? `Kept: ${t.tuned.features.slice(24).map((f) => FEATURE_NAMES[f] ?? f).join(", ")}.` : "None cleared the bar: their information is already carried by usage, xTD share and implied totals."}</p>
          </div>
        )}
        <p className="text-xs text-muted">Top-3 counts move by a few picks between settings ({Math.min(...t.stage_a.map((x) => x.top3_policy_hits))}–{Math.max(...t.stage_a.map((x) => x.top3_policy_hits))} of {t.stage_a[0].top3_policy_legs}), which is within noise, so settings were chosen on log loss across every player, not on top-3 hits.</p>
      </CardBody>
    </Card>
  );
}
