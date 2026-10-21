import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Upload } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { chicago, pct } from "@/lib/format";
import { useSeasonWeek, useTheme, type Theme } from "@/lib/state";
import { PageTitle } from "@/components/Layout";
import { Badge, Button, Card, CardBody, CardHeader, Input, Notice, Segmented, TableWrap, Td, Th } from "@/components/ui";

type Venom = {
  observations: { id: number; season: number; week: number; player_name: string; team: string; position: string; opponent: string; venom_rank: number | null;
    venom_score: number | null; venom_prob: number | null; observed_date: string; source_notes: string; imported_at: string }[];
  note: string; template_columns: string[];
};

export default function SettingsPage() {
  const [theme, setTheme] = useTheme();
  const { season, week } = useSeasonWeek();
  const qc = useQueryClient();
  const [s, setS] = React.useState(season);
  const [w, setW] = React.useState(week);
  const [text, setText] = React.useState("");
  const v = useQuery({ queryKey: ["venom"], queryFn: () => api.get<Venom>("/venom") });
  const imp = useMutation({
    mutationFn: () => api.post<{ inserted: number; errors: string[] }>("/venom/manual-import", { season: s, week: w, csv_text: text }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["venom"] }); qc.invalidateQueries({ queryKey: ["rankings"] }); setText(""); },
  });
  const onFile = async (f: File | undefined) => { if (f) setText(await f.text()); };
  return (
    <div className="space-y-5">
      <PageTitle title="Settings" />
      <Card>
        <CardHeader title="Appearance" />
        <CardBody>
          <Segmented<Theme> label="Theme" value={theme} onChange={setTheme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Manual Venom snapshot import" subtitle="Optional supplementary data from your own screenshots. Stored for one week only and never used in training or backtests." />
        <CardBody className="space-y-4">
          <Notice tone="info">Venom Score is a ranking number (0–100), not a probability. Do not read a score of 90 as a 90% chance. No private API is used: paste or upload a CSV you transcribed.</Notice>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm"><span className="label block">Season</span><Input type="number" value={s} onChange={(e) => setS(Number(e.target.value))} className="w-24" /></label>
            <label className="text-sm"><span className="label block">Week</span><Input type="number" min={1} max={22} value={w} onChange={(e) => setW(Number(e.target.value))} className="w-20" /></label>
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line px-3 text-sm hover:bg-raised">
              <Upload className="h-4 w-4" /> Choose CSV<input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="label mb-1 block">CSV text</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={(v.data?.template_columns ?? []).join(",")}
              className="w-full rounded-lg border border-line bg-surface p-3 font-mono text-xs" />
          </label>
          <p className="text-xs text-muted">Columns: {(v.data?.template_columns ?? []).join(", ")}. Re-importing the same player/week/date updates that row.</p>
          <Button variant="primary" onClick={() => imp.mutate()} disabled={!text.trim()} loading={imp.isPending}>Validate &amp; import for {s} Week {w}</Button>
          {imp.isSuccess && <p className="text-sm text-accent">Imported {imp.data.inserted} rows{imp.data.errors.length ? `; skipped: ${imp.data.errors.join("; ")}` : ""}.</p>}
          {imp.isError && <p className="text-sm text-danger">{imp.error instanceof ApiError ? imp.error.message : String(imp.error)}</p>}
        </CardBody>
        <TableWrap className="border-t border-line">
          <table className="w-full"><thead><tr><Th>Season/Wk</Th><Th>Player</Th><Th>Team</Th><Th>Opp</Th><Th className="text-right">Venom rank</Th><Th className="text-right">Venom score</Th><Th className="text-right">Venom shown %</Th><Th>Observed</Th><Th>Source</Th></tr></thead>
            <tbody>{v.data?.observations.map((o) => (
              <tr key={o.id}><Td>{o.season} · W{o.week}</Td><Td>{o.player_name}</Td><Td>{o.team}</Td><Td>{o.opponent}</Td><Td className="text-right">{o.venom_rank ?? "—"}</Td><Td className="text-right">{o.venom_score ?? "—"}</Td><Td className="text-right">{o.venom_prob != null ? pct(o.venom_prob) : "not visible"}</Td><Td>{o.observed_date}</Td><Td className="text-xs text-muted">{o.source_notes} · {chicago(o.imported_at)}</Td></tr>))}
              {v.data?.observations.length === 0 && <tr><Td colSpan={9} className="py-6 text-center text-muted">No observations imported.</Td></tr>}
            </tbody></table>
        </TableWrap>
      </Card>

      <Card>
        <CardHeader title="About" />
        <CardBody className="space-y-2 text-sm text-muted">
          <p>Fourth &amp; Goal Analytics is a local-first research tool. It is not a wagering platform and never labels a pick as guaranteed. If you bet, set limits in advance and never raise stakes to chase losses.</p>
          <p>Times display in Central time (America/Chicago); stored timestamps are ISO 8601 UTC. <Badge>v1.0.0</Badge></p>
        </CardBody>
      </Card>
    </div>
  );
}
