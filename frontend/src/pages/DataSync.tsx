import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Copy, Download, FileWarning, Play, Terminal, XCircle } from "lucide-react";
import { api, STATIC } from "@/lib/api";
import { chicago, cn, int } from "@/lib/format";
import type { DataStatus, Job } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { Badge, Button, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, Stat, Switch, TableWrap, Td, Th } from "@/components/ui";

const CLI = [
  "cd backend && pip install -r requirements.txt",
  "python -m engine.cli all --download     # fetch the nflverse CSVs, import, validate, predict",
  "python -m engine.cli all                # offline: CSVs already in data/raw/",
];

export default function DataSyncPage() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["data-status"], queryFn: () => api.get<DataStatus>("/data/status") });
  const [download, setDownload] = React.useState(false);
  const [force, setForce] = React.useState(false);
  const [jobId, setJobId] = React.useState<string | null>(null);
  const jobs = useQuery({ queryKey: ["jobs"], enabled: !STATIC, queryFn: () => api.get<Job[]>("/data/jobs") });
  React.useEffect(() => {
    const running = jobs.data?.find((j) => j.status === "running" || j.status === "queued");
    if (running && !jobId) setJobId(running.job_id);
  }, [jobs.data, jobId]);
  const job = useQuery({
    queryKey: ["job", jobId], enabled: !!jobId, queryFn: () => api.get<Job>(`/data/jobs/${jobId}`),
    refetchInterval: (q) => (q.state.data && ["running", "queued"].includes(q.state.data.status) ? 1500 : false),
  });
  React.useEffect(() => {
    if (job.data && ["succeeded", "failed"].includes(job.data.status)) {
      qc.invalidateQueries();
    }
  }, [job.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = useMutation({
    mutationFn: () => api.post<{ job_id: string }>("/data/refresh", { download, force, season: st.data?.season ?? 2026 }),
    onSuccess: (r) => setJobId(r.job_id),
  });
  const d = st.data;
  const running = job.data && ["running", "queued"].includes(job.data.status);
  const required = d?.sources.filter((s) => s.required) ?? [];
  const reqOk = required.filter((s) => s.status === "ok").length;

  if (st.isError) return <Card><ErrorState error={st.error} onRetry={() => st.refetch()} /></Card>;
  return (
    <div className="space-y-5">
      <PageTitle kicker="Sources, completeness and provenance" title="Data & sync" />
      {st.isLoading && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {d && (
        <>
          <Card className={cn(d.ready ? "border-accent/30" : "border-warn/40")}>
            <CardBody className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-3">
                {d.ready ? <CheckCircle2 className="h-8 w-8 text-accent" /> : <FileWarning className="h-8 w-8 text-warn" />}
                <div>
                  <div className="font-display text-lg font-semibold">{d.ready ? "League-wide data ready" : d.data_loaded ? "Data loaded, gates not all passing" : "Full NFLverse data not loaded"}</div>
                  <div className="text-sm text-muted">{d.season} · predicting Week {d.prediction_week} · {d.ready ? `analytics through Week ${Math.max(...(d.current_weeks ?? [0]))}` : "no league-wide rankings are shown until imports complete"}</div>
                </div>
              </div>
              <div className="flex flex-1 flex-wrap justify-end gap-6">
                <Stat label="Required files" value={`${reqOk}/${required.length}`} />
                <Stat label="Latest game" value={<span className="text-base">{d.latest_completed_gameday ?? "—"}</span>} />
                <Stat label="Status generated" value={<span className="text-base">{chicago(d.generated_at)}</span>} />
                <Stat label="Model" value={<span className="text-base">{d.model?.promoted ?? "not validated"}</span>} />
              </div>
            </CardBody>
          </Card>

          {d.error && <Notice tone="danger" title="Last run stopped — previous data kept">{d.error}</Notice>}
          {!d.data_loaded && (
            <Notice tone="warn" title="How to load the real data">
              Put the nine CSVs in <code className="font-mono text-fg">data/raw/</code> using the local names below (or tick “Download from nflverse”), then run the import.
              Nothing is filled in with estimates if a file is missing or a download fails.
            </Notice>
          )}

          <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
            {STATIC ? (
            <Card>
              <CardHeader title="Automatic refresh" icon={<Play className="h-4 w-4 text-accent" />} subtitle="This website is read-only and rebuilds itself" />
              <CardBody className="space-y-3 text-sm text-muted">
                <p>A scheduled job downloads the latest nflverse files, re-runs the import, walk-forward validation and predictions, and republishes
                  the site every Tuesday and Saturday morning (and before Thursday games). The numbers here are exactly what that run produced.</p>
                <p>Last build: <span className="text-fg">{chicago(d.generated_at)}</span>. Locked selections are saved in this browser only, so they do
                  not appear on another device. Use the CSV export to keep a copy.</p>
              </CardBody>
            </Card>
            ) : (
            <Card>
              <CardHeader title="Run import" icon={<Play className="h-4 w-4 text-accent" />} subtitle="The backend runs the CLI worker in the background; this page never touches files directly." />
              <CardBody className="space-y-4">
                <div className="flex flex-wrap gap-5">
                  <Switch id="dl" checked={download} onChange={setDownload} label="Download from nflverse" />
                  <Switch id="force" checked={force} onChange={setForce} label="Force re-import" />
                </div>
                <Button variant="primary" onClick={() => start.mutate()} loading={start.isPending || !!running} disabled={!!running}>
                  {running ? "Import running…" : "Import, build, validate & predict"}
                </Button>
                {start.isError && <p className="text-sm text-danger">{String(start.error)}</p>}
                <p className="text-xs text-muted">Unchanged files (same SHA-256) are skipped, so re-running is safe. Each file imports in one transaction: a failure keeps the previous data.</p>
                {job.data && (
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <Badge tone={job.data.status === "succeeded" ? "accent" : job.data.status === "failed" ? "danger" : "info"}>{job.data.status}</Badge>
                      <span className="text-muted">{job.data.job_id} · started {chicago(job.data.started_at)}{job.data.finished_at && ` · finished ${chicago(job.data.finished_at)}`}</span>
                    </div>
                    <pre aria-live="polite" className="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted">{job.data.log || "Waiting for output…"}</pre>
                    {job.data.error && <p className="mt-1 text-xs text-danger">{job.data.error}</p>}
                  </div>
                )}
              </CardBody>
            </Card>
            )}
            <Card>
              <CardHeader title="Command line" icon={<Terminal className="h-4 w-4 text-muted" />} subtitle="Same worker, run directly" />
              <CardBody>
                <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed">{CLI.join("\n")}</pre>
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => navigator.clipboard?.writeText(CLI.join("\n"))}><Copy className="h-3.5 w-3.5" /> Copy</Button>
                <div className="mt-4 label">Quality gates</div>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {d.gates.length === 0 && <li className="text-muted">Gates are evaluated after the first import.</li>}
                  {d.gates.map((g) => (
                    <li key={g.gate} className="flex gap-2">
                      {g.pass ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-label="pass" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="fail" />}
                      <span>{g.gate}: <span className="num font-medium">{Array.isArray(g.value) ? (g.value as number[]).join(", ") : int(g.value)}</span>
                        <span className="text-muted"> (need {Array.isArray(g.threshold) ? `weeks ${(g.threshold as number[]).join(", ")}` : `≥ ${int(g.threshold)}`})</span></span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Source files" subtitle="Required = the nine files the engine needs; the rest unlock lines, injuries and snap participation" />
            <TableWrap>
              <table className="w-full">
                <thead><tr><Th>Status</Th><Th>Kind</Th><Th>Season</Th><Th>Local file</Th><Th className="text-right">Rows</Th><Th>Imported (CT)</Th><Th>File modified</Th><Th>SHA-256</Th><Th>Source</Th></tr></thead>
                <tbody>
                  {d.sources.map((s) => (
                    <tr key={s.kind + s.season}>
                      <Td>
                        <span className="inline-flex items-center gap-1.5">
                          {s.status === "ok" ? <CheckCircle2 className="h-4 w-4 text-accent" /> : s.status === "error" ? <XCircle className="h-4 w-4 text-danger" /> : <Circle className="h-4 w-4 text-muted" />}
                          <span className="text-xs">{s.status.replace("_", " ")}</span>
                          {s.required && <Badge tone="neutral">required</Badge>}
                        </span>
                      </Td>
                      <Td title={s.description}>{s.kind}</Td><Td>{s.season ?? "all"}</Td>
                      <Td className="font-mono text-xs">{s.local_file}{!s.local_present && <span className="ml-1 text-warn">(absent)</span>}</Td>
                      <Td className="text-right">{int(s.rows_imported)}</Td>
                      <Td className="text-xs">{chicago(s.imported_at)}</Td><Td className="text-xs">{chicago(s.file_mtime)}</Td>
                      <Td className="font-mono text-[11px] text-muted" title={s.sha256 ?? ""}>{s.sha256 ? s.sha256.slice(0, 12) : "—"}</Td>
                      <Td><a href={s.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline"><Download className="h-3 w-3" />nflverse</a></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            {d.sources.some((s) => s.message) && (
              <div className="space-y-1 border-t border-line px-5 py-3 text-xs text-danger">{d.sources.filter((s) => s.message).map((s) => <div key={s.kind + s.season}>{s.local_file}: {s.message}</div>)}</div>
            )}
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Licensing & attribution" />
              <CardBody className="text-sm text-muted">{d.license}</CardBody>
            </Card>
            <Card>
              <CardHeader title="Method limits" />
              <CardBody>
                <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
                  <li>End-zone target is a <strong>proxy</strong>: air yards ≥ yards to goal. It is not a charted ball location.</li>
                  <li>An incomplete target is a missed scoring opportunity, never a “drop”. Catchability is not in play-by-play.</li>
                  <li>Play-based xTD is the historical conversion rate of a player's opportunities; it is not his next-game TD probability.</li>
                  <li>A weekly roster row is not proof a player was active; participation uses box scores and snap counts.</li>
                  <li>Passing TDs thrown by quarterbacks never count as anytime TDs.</li>
                  <li>{d.coverage_tracking ?? "Coverage tracking not connected."}</li>
                  <li>Venom values are user-entered screenshot observations for the week captured only.</li>
                </ul>
              </CardBody>
            </Card>
          </div>

          <Card>
            <details>
              <summary className="cursor-pointer px-5 py-3 font-display text-[15px] font-semibold">build_status.json <span className="ml-2 font-mono text-xs font-normal text-muted">{d.build_status_path ?? "not written yet"}</span></summary>
              <pre className="max-h-[480px] overflow-auto border-t border-line bg-bg p-4 font-mono text-[11px] leading-relaxed text-muted">{JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== "sources")), null, 2)}</pre>
            </details>
          </Card>
        </>
      )}
    </div>
  );
}
