import * as React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, BarChart3, Database, Flame, LayoutDashboard, ListOrdered, Moon, Settings, Shield, SlidersHorizontal, Sun, Target, Menu, X,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import { useLinkSuffix, useSeasonWeek, useTheme, type WeeksResponse } from "@/lib/state";
import { Select } from "./ui";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/rankings", label: "Rankings", icon: ListOrdered },
  { to: "/parlay", label: "Top 3", icon: Target },
  { to: "/props", label: "Props", icon: SlidersHorizontal },
  { to: "/trends", label: "Who scores", icon: Flame },
  { to: "/defenses", label: "Defenses", icon: Shield },
  { to: "/backtest", label: "Backtest", icon: BarChart3 },
  { to: "/data", label: "Data & Sync", icon: Database },
  { to: "/settings", label: "Settings", icon: Settings },
];
const MOBILE = NAV.slice(0, 5);

type Health = { data_loaded: boolean; ready: boolean; calibrated: boolean };

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-raised" />
        <path d="M9 23V9h10M9 16h7" className="stroke-accent" strokeWidth="3" fill="none" strokeLinecap="round" />
        <circle cx="23" cy="22" r="2.5" className="fill-accent" />
      </svg>
      {!compact && (
        <div className="leading-tight">
          <div className="font-display text-[15px] font-bold tracking-tight">Fourth &amp; Goal</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Analytics</div>
        </div>
      )}
    </div>
  );
}

function SeasonWeekPicker() {
  const { season, week, set } = useSeasonWeek();
  const weeks = useQuery({ queryKey: ["weeks", season], queryFn: () => api.get<WeeksResponse>("/weeks", { season }), staleTime: 60_000 });
  const seasons = weeks.data?.seasons ?? [season];
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="season-select">Season</label>
      <Select id="season-select" value={season} onChange={(e) => set(Number(e.target.value), Number(e.target.value) === weeks.data?.current_season ? weeks.data.current_week : 1)} className="h-8 text-xs">
        {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
      </Select>
      <label className="sr-only" htmlFor="week-select">Week</label>
      <Select id="week-select" value={week} onChange={(e) => set(season, Number(e.target.value))} className="h-8 text-xs">
        {(weeks.data?.weeks ?? [{ week, status: "", has_predictions: true }]).map((w) => (
          <option key={w.week} value={w.week} disabled={!w.has_predictions}>
            Week {w.week}{w.status === "upcoming" ? " · upcoming" : w.status === "in_progress" ? " · live" : ""}{!w.has_predictions ? " · no run" : ""}
          </option>
        ))}
      </Select>
    </div>
  );
}

function StatusChip() {
  const h = useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/health"), refetchInterval: 30_000 });
  const suffix = useLinkSuffix();
  const state = h.isError ? "offline" : !h.data ? "…" : !h.data.data_loaded ? "no-data" : h.data.calibrated ? "validated" : "research";
  const label = { offline: "API offline", "…": "Checking", "no-data": "Data not loaded", validated: "Model validated", research: "Research ranks only" }[state];
  const tone = state === "validated" ? "bg-accent" : state === "research" ? "bg-info" : state === "…" ? "bg-muted" : "bg-warn";
  return (
    <NavLink to={`/data${suffix}`} className="hidden items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-fg sm:flex">
      <span className={cn("h-2 w-2 rounded-full", tone)} aria-hidden />
      {label}
    </NavLink>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark = theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"));
  return (
    <button
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function Layout() {
  const suffix = useLinkSuffix();
  const [open, setOpen] = React.useState(false);
  const loc = useLocation();
  React.useEffect(() => setOpen(false), [loc.pathname]);
  const link = (n: (typeof NAV)[number]) => (
    <NavLink
      key={n.to}
      to={n.to + suffix}
      end={n.end}
      className={({ isActive }) =>
        cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg")
      }
    >
      {({ isActive }) => (
        <>
          <n.icon className={cn("h-4 w-4", isActive && "text-accent")} aria-hidden />
          {n.label}
        </>
      )}
    </NavLink>
  );
  return (
    <div className="flex min-h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface/40 px-3 py-4 lg:flex">
        <div className="px-2 pb-6"><Logo /></div>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5">{NAV.map(link)}</nav>
        <div className="mt-4 rounded-lg border border-line p-3 text-[11px] leading-relaxed text-muted">
          <Activity className="mb-1 h-3.5 w-3.5 text-accent" aria-hidden />
          Football research, not betting advice. No pick is guaranteed.
        </div>
      </aside>
      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <nav className="absolute left-0 top-0 flex h-full w-64 flex-col gap-0.5 bg-surface p-3">
            <div className="mb-4 flex items-center justify-between px-2"><Logo /><button aria-label="Close menu" onClick={() => setOpen(false)}><X className="h-5 w-5" /></button></div>
            {NAV.map(link)}
          </nav>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur sm:px-6">
          <button className="lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></button>
          <div className="lg:hidden"><Logo compact /></div>
          <div className="flex-1" />
          <SeasonWeekPicker />
          <StatusChip />
          <ThemeToggle />
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-24 pt-5 sm:px-6 lg:pb-10">
          <Outlet />
        </main>
      </div>
      {/* Mobile bottom nav */}
      <nav aria-label="Primary mobile" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 backdrop-blur lg:hidden">
        {MOBILE.map((n) => (
          <NavLink key={n.to} to={n.to + suffix} end={n.end}
            className={({ isActive }) => cn("flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium", isActive ? "text-accent" : "text-muted")}>
            <n.icon className="h-5 w-5" aria-hidden />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function PageTitle({ title, kicker, children }: { title: string; kicker?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {kicker && <div className="label mb-1">{kicker}</div>}
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-[28px]">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
