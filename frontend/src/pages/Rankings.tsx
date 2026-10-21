import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type SortingState, type VisibilityState } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Columns3, Download, Pin, Search } from "lucide-react";
import { api } from "@/lib/api";
import { chicago, cn, kickoff, num, pct, POSITIONS } from "@/lib/format";
import { useLinkSuffix, usePins, useSeasonWeek } from "@/lib/state";
import type { RankingRow, RankingsResponse } from "@/lib/types";
import { PageTitle } from "@/components/Layout";
import { Badge, Button, Card, ErrorState, Input, LoadingBlock, PosBadge, Segmented, Switch, TeamBadge } from "@/components/ui";
import { ConfidenceBadge, Flags, ModelBadge, NoDataState, Outcome, ReasonList } from "@/components/shared";

const h = createColumnHelper<RankingRow>();
const SORTABLE = new Set(["rank", "score", "p_model", "player_name", "team", "position", "opponent", "rz_carries_pg", "goal5_carries_pg",
  "rz_targets_pg", "ez_proxy_pg", "xtd_pg", "td_pg", "xtd_share", "team_implied_total", "opp_def_pos_td_pg", "carries_pg", "targets_pg"]);

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = React.useState(v);
  React.useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export default function RankingsPage() {
  const { season, week } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const nav = useNavigate();
  const pins = usePins();
  const [positions, setPositions] = React.useState<string[]>([]);
  const [search, setSearch] = React.useState("");
  const [team, setTeam] = React.useState("");
  const [eligibleOnly, setEligibleOnly] = React.useState(true);
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "rank", desc: false }]);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [visibility, setVisibility] = React.useState<VisibilityState>(() => {
    try { return JSON.parse(localStorage.getItem("fg-cols") || "{}"); } catch { return {}; }
  });
  React.useEffect(() => { try { localStorage.setItem("fg-cols", JSON.stringify(visibility)); } catch { /* ignore */ } }, [visibility]);
  const q = useDebounced(search);
  React.useEffect(() => setPage(1), [positions, q, team, eligibleOnly, sorting, season, week]);

  const sort = sorting[0];
  const params = { season, week, position: positions, search: q, team: team || undefined, eligible_only: eligibleOnly,
    sort: sort?.id ?? "rank", order: sort ? (sort.desc ? "desc" : "asc") : "asc", page, page_size: pageSize };
  const res = useQuery({ queryKey: ["rankings", params], queryFn: () => api.get<RankingsResponse>("/rankings", params) });
  const d = res.data;
  const calibrated = !!d?.calibrated;
  const fa = d?.fields_available ?? {};

  const columns = React.useMemo(() => [
    h.display({ id: "pin", header: () => <span className="sr-only">Pin</span>, enableHiding: false, cell: ({ row }) => {
      const r = row.original;
      const on = pins.has(r.player_id);
      return (
        <button aria-pressed={on} aria-label={on ? `Unpin ${r.player_name}` : `Pin ${r.player_name} for comparison`} disabled={!r.eligible}
          onClick={(e) => { e.stopPropagation(); pins.toggle({ player_id: r.player_id, team: r.team, player_name: r.player_name, position: r.position, opponent: r.opponent, season, week }); }}
          className={cn("rounded p-1 hover:bg-raised disabled:opacity-30", on ? "text-accent" : "text-muted")}>
          <Pin className="h-3.5 w-3.5" fill={on ? "currentColor" : "none"} />
        </button>
      );
    } }),
    h.accessor("rank", { header: "Rank", enableHiding: false, cell: (c) => <span className="font-mono text-muted">{c.getValue() ?? "—"}</span> }),
    h.accessor("player_name", { header: "Player", enableHiding: false, cell: ({ row }) => (
      <div className="flex min-w-[180px] items-center gap-2">
        <TeamBadge team={row.original.team} />
        <div className="min-w-0">
          <Link to={`/players/${row.original.player_id}${suffix}`} onClick={(e) => e.stopPropagation()} className="block truncate font-medium hover:text-accent">{row.original.player_name}</Link>
          {!row.original.eligible && <span className="text-[11px] text-danger">{row.original.exclusion}</span>}
        </div>
      </div>
    ) }),
    h.accessor("position", { header: "Pos", cell: (c) => <PosBadge pos={c.getValue()} /> }),
    h.accessor("opponent", { header: "Opp", cell: ({ row }) => <span className="text-muted">{row.original.is_home ? "vs" : "@"} <span className="text-fg">{row.original.opponent}</span></span> }),
    h.accessor((r) => r.gameday, { id: "game_time", header: "Kickoff (CT)", enableSorting: false, cell: ({ row }) => <span className="text-xs text-muted">{kickoff(row.original.gameday, row.original.gametime)}</span> }),
    h.accessor("p_model", { header: () => <span title="Validated P(1+ rush/rec TD). Hidden unless the model passed the promotion gate.">P(TD)</span>,
      cell: (c) => calibrated ? <span className="font-semibold">{pct(c.getValue(), 0)}</span> : <span className="text-muted" title="Not validated">hidden</span> }),
    h.accessor("score", { header: () => <span title="Percentile among eligible players. Not a probability.">Score</span>, cell: (c) => num(c.getValue(), 0) }),
    h.accessor((r) => r.features.carries_pg, { id: "carries_pg", header: "Car/g", cell: (c) => num(c.getValue()) }),
    h.accessor((r) => r.features.targets_pg, { id: "targets_pg", header: "Tgt/g", cell: (c) => num(c.getValue()) }),
    h.accessor((r) => r.features.rz_carries_pg, { id: "rz_carries_pg", header: () => <span title="Carries from inside the 20, per game">RZ car/g</span>, cell: (c) => num(c.getValue()) }),
    h.accessor((r) => r.features.goal5_carries_pg, { id: "goal5_carries_pg", header: () => <span title="Carries from inside the 5, per game">≤5 car/g</span>, cell: (c) => num(c.getValue()) }),
    h.accessor((r) => r.features.rz_targets_pg, { id: "rz_targets_pg", header: () => <span title="Targets with the line of scrimmage inside the 20, per game">RZ tgt/g</span>, cell: (c) => num(c.getValue()) }),
    h.accessor((r) => r.features.ez_proxy_pg, { id: "ez_proxy_pg", header: () => <span title="End-zone target proxy (air yards ≥ yards to goal). Not charted.">EZ proxy/g</span>, cell: (c) => num(c.getValue(), 2) }),
    h.accessor((r) => r.features.xtd_pg, { id: "xtd_pg", header: () => <span title="Play-based xTD per game">xTD/g</span>, cell: (c) => num(c.getValue(), 2) }),
    h.accessor((r) => r.features.td_pg, { id: "td_pg", header: "TD/g", cell: (c) => num(c.getValue(), 2) }),
    h.accessor((r) => r.features.xtd_share, { id: "xtd_share", header: () => <span title="Share of team xTD in games played">xTD share</span>, cell: (c) => pct(c.getValue()) }),
    h.accessor((r) => r.features.team_implied_total, { id: "team_implied_total", header: () => <span title="Market-implied team points">Team imp.</span>, cell: (c) => num(c.getValue()) }),
    h.accessor((r) => r.features.opp_def_pos_td_pg_raw, { id: "opp_def_pos_td_pg", header: () => <span title="Opponent TDs allowed to this position per game (prior games only)">Opp pos TD/g</span>,
      cell: ({ row }) => <span>{num(row.original.features.opp_def_pos_td_pg_raw, 2)}<span className="text-muted"> /{num(row.original.features.opp_def_games, 0)}g</span></span> }),
    h.accessor("confidence", { header: "Data", enableSorting: false, cell: (c) => <ConfidenceBadge c={c.getValue()} /> }),
    h.accessor("venom_score", { header: () => <span title="User-entered Venom screenshot value for this week only. A ranking number, not a probability.">Venom</span>, enableSorting: false,
      cell: (c) => c.getValue() != null ? <Badge tone="neutral">{num(c.getValue(), 1)}</Badge> : <span className="text-muted">—</span> }),
    h.display({ id: "outcome", header: "Result", cell: ({ row }) => <Outcome outcome={row.original.outcome} participated={row.original.participated} /> }),
    h.display({ id: "flags", header: "Flags", cell: ({ row }) => row.original.flags.length ? <Badge tone="warn" title={row.original.flags.join("\n")}>{row.original.flags.length}</Badge> : null }),
  ], [calibrated, pins, suffix, season, week]);

  const table = useReactTable({
    data: d?.rows ?? [], columns, getCoreRowModel: getCoreRowModel(), manualSorting: true, manualPagination: true,
    state: { sorting, columnVisibility: { venom_score: !!fa.venom, outcome: !!fa.outcomes, p_model: calibrated, ...visibility } },
    onSortingChange: setSorting, onColumnVisibilityChange: setVisibility, enableSortingRemoval: false,
    getRowId: (r) => r.player_id + r.team,
  });
  const pages = d ? Math.max(1, Math.ceil(d.total / d.page_size)) : 1;
  const [colsOpen, setColsOpen] = React.useState(false);

  return (
    <div className="space-y-4">
      <PageTitle kicker={`${season} · Week ${week}`} title="Player rankings">
        {d?.run_id && <ModelBadge version={d.model_version} calibrated={calibrated} />}
        <a href={api.url("/export/rankings.csv", { season, week })} download>
          <Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export CSV</Button>
        </a>
      </PageTitle>

      <Card className="p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
            <Input aria-label="Search players" placeholder="Search players" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <div role="group" aria-label="Positions" className="flex gap-1">
            {POSITIONS.map((p) => {
              const on = positions.includes(p);
              return (
                <button key={p} aria-pressed={on} onClick={() => setPositions((cur) => on ? cur.filter((x) => x !== p) : [...cur, p])}
                  className={cn("h-8 rounded-lg border px-3 font-mono text-xs font-semibold", on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}>{p}</button>
              );
            })}
          </div>
          <Input aria-label="Team or opponent" placeholder="Team (e.g. DET)" value={team} onChange={(e) => setTeam(e.target.value.toUpperCase().slice(0, 3))} className="w-36" />
          <Switch id="elig" checked={eligibleOnly} onChange={setEligibleOnly} label="Eligible only" />
          <div className="relative ml-auto hidden md:block">
            <Button variant="ghost" size="sm" onClick={() => setColsOpen((o) => !o)} aria-expanded={colsOpen}><Columns3 className="h-3.5 w-3.5" /> Columns <ChevronDown className="h-3 w-3" /></Button>
            {colsOpen && (
              <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-line bg-surface p-2 shadow-xl">
                {table.getAllLeafColumns().filter((c) => c.getCanHide()).map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-raised">
                    <input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} className="accent-[rgb(var(--accent))]" />
                    {c.id.replace(/_/g, " ")}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
        {d?.run_id && (
          <p className="mt-3 text-xs text-muted">
            {d.total} players · data cutoff {d.data_cutoff} · generated {chicago(d.as_of)} ·{" "}
            {calibrated ? "P(TD) is a validated game-level estimate; Score is a percentile rank, not a probability." : "Probabilities are hidden because no model has passed validation."}
            {!fa.injury_report && " Injury reports not yet published for this week."}
          </p>
        )}
      </Card>

      {pins.pins.length > 0 && (
        <Card className="flex flex-wrap items-center gap-2 p-3">
          <span className="label mr-1">Pinned</span>
          {pins.pins.map((p) => <Badge key={p.player_id} tone="accent">{p.player_name}</Badge>)}
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={pins.clear}>Clear</Button>
          <Link to={`/parlay${suffix}`}><Button size="sm" variant="primary">Use in Top 3 builder</Button></Link>
        </Card>
      )}

      <Card className="overflow-hidden">
        {res.isError && <ErrorState error={res.error} onRetry={() => res.refetch()} />}
        {res.isLoading && <LoadingBlock rows={10} className="p-4" />}
        {d && !d.run_id && <NoDataState reason={d.empty_reason} />}
        {d?.run_id && d.rows.length === 0 && <p className="p-8 text-center text-sm text-muted">No players match these filters.</p>}
        {d?.run_id && d.rows.length > 0 && (
          <>
            {/* Desktop table */}
            <div className={cn("hidden overflow-x-auto md:block", res.isFetching && "opacity-70")}>
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-surface">
                  {table.getHeaderGroups().map((hg) => (
                    <tr key={hg.id}>
                      {hg.headers.map((hd) => {
                        const can = SORTABLE.has(hd.column.id) && hd.column.getCanSort() && !(hd.column.id === "p_model" && !calibrated);
                        const s = hd.column.getIsSorted();
                        return (
                          <th key={hd.id} scope="col" aria-sort={s ? (s === "asc" ? "ascending" : "descending") : "none"}
                            className="whitespace-nowrap border-b border-line px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                            {can ? (
                              <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => setSorting([{ id: hd.column.id, desc: s ? s === "asc" : !["rank", "player_name", "team", "position", "opponent"].includes(hd.column.id) }])}>
                                {flexRender(hd.column.columnDef.header, hd.getContext())}
                                {s === "asc" ? <ArrowUp className="h-3 w-3" /> : s === "desc" ? <ArrowDown className="h-3 w-3" /> : null}
                              </button>
                            ) : flexRender(hd.column.columnDef.header, hd.getContext())}
                          </th>
                        );
                      })}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <React.Fragment key={row.id}>
                      <tr tabIndex={0} onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                        onKeyDown={(e) => { if (e.key === "Enter") nav(`/players/${row.original.player_id}${suffix}`); if (e.key === " ") { e.preventDefault(); setExpanded(expanded === row.id ? null : row.id); } }}
                        aria-expanded={expanded === row.id}
                        className={cn("cursor-pointer hover:bg-raised/50", !row.original.eligible && "opacity-60", expanded === row.id && "bg-raised/40")}>
                        {row.getVisibleCells().map((cell) => (
                          <td key={cell.id} className="num whitespace-nowrap border-b border-line/60 px-3 py-2 text-sm">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                        ))}
                      </tr>
                      {expanded === row.id && (
                        <tr className="bg-raised/30">
                          <td colSpan={row.getVisibleCells().length} className="border-b border-line px-6 py-4">
                            <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
                              <div><div className="label mb-2">Why ranked here</div><ReasonList reasons={row.original.reasons} /></div>
                              <div><div className="label mb-2">Flags</div>{row.original.flags.length ? <Flags flags={row.original.flags} /> : <span className="text-sm text-muted">None</span>}
                                <Link to={`/players/${row.original.player_id}${suffix}`} className="mt-3 inline-block text-sm text-accent hover:underline">Open player page →</Link></div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <ul className="divide-y divide-line md:hidden">
              {d.rows.map((r) => (
                <li key={r.player_id + r.team}>
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                      <span className="w-7 font-mono text-xs text-muted">{r.rank ?? "—"}</span>
                      <TeamBadge team={r.team} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{r.player_name}</div>
                        <div className="text-xs text-muted">{r.position} · {r.is_home ? "vs" : "@"} {r.opponent} · {num(r.features.rz_carries_pg)} RZ car · {num(r.features.rz_targets_pg)} RZ tgt</div>
                      </div>
                      <div className="text-right">
                        <div className="num font-display text-base font-semibold">{calibrated ? pct(r.p_model) : num(r.score, 0)}</div>
                        <div className="text-[10px] uppercase text-muted">{calibrated ? "P(TD)" : "score"}</div>
                      </div>
                    </summary>
                    <div className="space-y-3 px-4 pb-4">
                      <ReasonList reasons={r.reasons} />
                      <Flags flags={r.flags} />
                      <Link to={`/players/${r.player_id}${suffix}`} className="text-sm text-accent">Open player page →</Link>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm">
              <div className="flex items-center gap-2 text-muted">
                Rows
                <Segmented size="sm" label="Rows per page" value={pageSize} onChange={(v) => { setPageSize(v); setPage(1); }} options={[25, 50, 100].map((n) => ({ value: n, label: n }))} />
              </div>
              <div className="flex items-center gap-2">
                <Button size="icon" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                <span className="num text-muted">Page {page} of {pages}</span>
                <Button size="icon" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
