// Runs a large batch of questions against this week's real exported data and writes every answer to a file for review.
// Only runs with BATTERY=1 (it needs ../site-data from engine.export_static).
import { describe, it } from "vitest";
import fs from "node:fs";
import { answer, estimatedLine, parse, type AskData } from "./ask";
import { dueRecord } from "./signals";

const SD = "../site-data";
const j = (p: string) => JSON.parse(fs.readFileSync(`${SD}/${p}`, "utf8"));
const OUT = process.env.BATTERY_OUT ?? "battery.txt";
const QS = (process.env.BATTERY_QS ? fs.readFileSync(process.env.BATTERY_QS, "utf8") : "").split("\n").map((x) => x.trim()).filter(Boolean);

function load(withBook: boolean): AskData {
  const ranks = j("rankings/season-2026_week-7.json");
  const markets = j("props/markets/index.json").markets.filter((m: { validated: boolean }) => m.validated);
  const props: AskData["props"] = {};
  for (const m of markets) props[m.market] = { label: m.label, rows: j(`props/season-2026_week-7_market-${m.market}.json`).rows };
  const model = j("parlay/model/index.json");
  // Simulated book: main lines at each player's usual line for the markets the free odds plan pulls, -115 both sides.
  const idx = new Map<string, { book: string; price: number; line: number | null; market: string; player_id: string; side: string }[]>();
  if (withBook) {
    for (const r of ranks.rows) if (r.eligible && r.p_model != null && r.p_model > 0.12) idx.set(`td:${r.player_id}:yes`, [{ book: "draftkings", price: Math.round(r.p_model > 0.5 ? -100 * r.p_model / (1 - r.p_model) * 1.1 : 100 * (1 - r.p_model) / r.p_model * 0.85), line: null, market: "td", player_id: r.player_id, side: "yes" }]);
    for (const m of ["receptions", "pass_yards", "pass_tds", "rec_yards", "rush_yards"]) for (const r of props[m]?.rows ?? []) {
      if (!r.eligible || !r.recent?.length) continue;
      const line = estimatedLine(r, m).line;
      if (line < ({ receptions: 1.5, pass_yards: 150, pass_tds: 0.5, rec_yards: 9.5, rush_yards: 9.5 } as Record<string, number>)[m]) continue; // books do not post these
      for (const side of ["over", "under"]) idx.set(`${m}:${r.player_id}:${side}`, [{ book: "draftkings", price: -115, line, market: m, player_id: r.player_id, side }]);
    }
  }
  return { season: 2026, week: 7, td: ranks.rows.filter((r: { eligible: boolean }) => r.eligible), props,
    feed: { at: withBook ? "2026-10-24T14:00:00Z" : null, get: (m, p, s) => (idx.get(`${m}:${p}:${s}`) ?? []) as never },
    conf: j("backtest/confidence/index.json"), buckets: model.buckets ?? {}, useCorr: !!model.use_correlation, dueRecord: dueRecord(j("backtest/due/index.json")) };
}

describe.runIf(process.env.BATTERY)("ask battery", () => {
  it("answers every question", () => {
    const out: string[] = [];
    for (const book of [false, true]) {
      const d = load(book);
      out.push(`######## ${book ? "WITH BOOK LINES" : "NO BOOK LINES"}`);
      for (const q of QS) {
        try {
          const p = parse(d, q);
          const a = answer(d, q);
          const picks = (a.picks ?? a.groups?.flatMap((g) => g.picks) ?? []).slice(0, 6).map((x) => `${x.name} ${x.label} ${Math.round(x.p * 100)}%${x.tier ? ` ${x.tier}` : ""}${x.lineSource === "usual" ? " (usual)" : ""}`);
          const tbl = (a as { table?: { rows: unknown[][] } }).table?.rows.slice(0, 4).map((r) => r.join(" | ")) ?? [];
          const proj = a.projections?.slice(0, 3).map((x) => `${x.name} ${x.market} ${x.median}`) ?? [];
          out.push(`Q: ${q}\n  [${p.intent}${p.market ? ` ${p.market}` : ""}${p.players.length ? ` players=${p.players.length}` : ""}${p.n ? ` n=${p.n}` : ""}${p.line != null ? ` line=${p.line}` : ""}${p.side ? ` ${p.side}` : ""}] ${a.title}\n  ${a.summary.slice(0, 220)}${picks.length ? `\n  - ${picks.join("\n  - ")}` : ""}${tbl.length ? `\n  T ${tbl.join("\n  T ")}` : ""}${proj.length ? `\n  P ${proj.join("; ")}` : ""}${a.parlay ? `\n  parlay joint ${(a.parlay.joint * 100).toFixed(1)}%` : ""}`);
        } catch (e) { out.push(`Q: ${q}\n  !! ERROR ${(e as Error).stack?.split("\n").slice(0, 3).join(" ")}`); }
      }
    }
    fs.writeFileSync(OUT, out.join("\n"));
  });
});
