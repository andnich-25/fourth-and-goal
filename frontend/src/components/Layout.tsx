import * as React from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, BarChart3, BookOpen, Database, Dices, MessageCircleQuestion, Flame, LayoutDashboard, ListOrdered, Moon, Settings, Shield, SlidersHorizontal, Sun, Target, Percent, Menu, X,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import { useLinkSuffix, useSeasonWeek, useTheme, type WeeksResponse } from "@/lib/state";
import { Select } from "./ui";

type NavItem = { to: string; label: string; short?: string; icon: typeof LayoutDashboard; end?: boolean };
const SECTIONS: { title: string; items: NavItem[] }[] = [
  { title: "Picks", items: [
    { to: "/", label: "This week", short: "Home", icon: LayoutDashboard, end: true },
    { to: "/ask", label: "Ask", icon: MessageCircleQuestion },
    { to: "/builder", label: "Parlay builder", short: "Parlay", icon: Dices },
    { to: "/parlay", label: "Top 3 & locks", short: "Top 3", icon: Target },
  ] },
  { title: "Research", items: [
    { to: "/rankings", label: "All players", icon: ListOrdered },
    { to: "/props", label: "Player props", short: "Props", icon: SlidersHorizontal },
    { to: "/hitrates", label: "Hit rates", icon: Percent },
    { to: "/trends", label: "Trends", icon: Flame },
    { to: "/defenses", label: "Defenses", icon: Shield },
  ] },
  { title: "Proof", items: [
    { to: "/how", label: "How it works", icon: BookOpen },
    { to: "/backtest", label: "Track record", icon: BarChart3 },
  ] },
  { title: "", items: [
    { to: "/data", label: "Data", icon: Database },
    { to: "/settings", label: "Settings", icon: Settings },
  ] },
];
const NAV = SECTIONS.flatMap((s) => s.items);
const MOBILE = [NAV[0], NAV[1], NAV[2], NAV[3]];
const NBA_SECTIONS: { title: string; items: NavItem[] }[] = [
  { title: "Picks", items: [
    { to: "/nba", label: "Today", short: "Home", icon: LayoutDashboard, end: true },
    { to: "/nba/ask", label: "Ask", icon: MessageCircleQuestion },
    { to: "/nba/builder", label: "Parlay builder", short: "Parlay", icon: Dices },
  ] },
  { title: "Research", items: [{ to: "/nba/props", label: "Player props", short: "Props", icon: SlidersHorizontal }] },
  { title: "Proof", items: [
    { to: "/nba/how", label: "How it works", icon: BookOpen },
    { to: "/nba/record", label: "Track record", icon: BarChart3 },
  ] },
  { title: "", items: [{ to: "/settings", label: "Settings", icon: Settings }] },
];
const NBA_NAV = NBA_SECTIONS.flatMap((s) => s.items);
const NBA_MOBILE = [NBA_NAV[0], NBA_NAV[3], NBA_NAV[1], NBA_NAV[2]];

/** NFL / NBA switch. Each sport keeps its own pages; the switch goes to that sport's home. */
function SportSwitch({ nba }: { nba: boolean }) {
  const base = "rounded-md px-2.5 py-1.5 text-sm font-bold tracking-wide transition-colors sm:px-3.5";
  return (
    <div className="flex rounded-lg border border-line bg-surface p-1" role="tablist" aria-label="Sport">
      <NavLink to="/" role="tab" aria-selected={!nba} className={cn(base, !nba ? "bg-accent text-accent-fg" : "text-muted hover:bg-raised hover:text-fg")}>NFL</NavLink>
      <NavLink to="/nba" role="tab" aria-selected={nba} className={cn(base, nba ? "bg-accent text-accent-fg" : "text-muted hover:bg-raised hover:text-fg")}>NBA</NavLink>
    </div>
  );
}

type Health = { data_loaded: boolean; ready: boolean; calibrated: boolean };

export function Logo({ compact = false, nba = false }: { compact?: boolean; nba?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-raised" />
        {nba ? (
          /* Basketball: outline and seams */
          <g className="stroke-accent" strokeWidth="2" fill="none" strokeLinecap="round">
            <circle cx="16" cy="16" r="9.5" />
            <path d="M16 6.5v19M6.5 16h19M9.6 9c2.9 3.8 2.9 10.2 0 14M22.4 9c-2.9 3.8-2.9 10.2 0 14" />
          </g>
        ) : (
          <>
            {/* Lab flask: neck, body and the liquid line */}
            <path d="M13 7h6M14 7v6.5L8.6 22.8A2 2 0 0 0 10.3 26h11.4a2 2 0 0 0 1.7-3.2L18 13.5V7" className="stroke-accent" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M11.2 19.5h9.6l2 3.4a1 1 0 0 1-.9 1.6H10.1a1 1 0 0 1-.9-1.6z" className="fill-accent" />
          </>
        )}
      </svg>
      {!compact && (
        <div className="leading-tight">
          <div className="font-display text-[15px] font-bold tracking-tight">The Lab{nba && <span className="text-accent"> NBA</span>}</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">{nba ? "Hoops · Props · Sims" : "Props · Sims · Data"}</div>
        </div>
      )}
    </div>
  );
}

/** The NBA side is styled as its own site: palette (index.css), favicon and tab title follow the sport. */
function useSportTheme(nba: boolean) {
  React.useLayoutEffect(() => {
    const root = document.documentElement;
    if (nba) root.dataset.sport = "nba"; else delete root.dataset.sport;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = `${import.meta.env.BASE_URL}${nba ? "favicon-nba.svg" : "favicon.svg"}`;
    document.title = nba ? "The Lab NBA" : "The Lab";
  }, [nba]);
}

function SeasonWeekPicker() {
  const { season, week, set } = useSeasonWeek();
  const weeks = useQuery({ queryKey: ["weeks", season], queryFn: () => api.get<WeeksResponse>("/weeks", { season }), staleTime: 60_000 });
  const seasons = weeks.data?.seasons ?? [season];
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="season-select">Season</label>
      <Select id="season-select" value={season} onChange={(e) => set(Number(e.target.value), Number(e.target.value) === weeks.data?.current_season ? weeks.data.current_week : 1)} className="h-8 w-[4.5rem] text-xs sm:w-auto">
        {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
      </Select>
      <label className="sr-only" htmlFor="week-select">Week</label>
      <Select id="week-select" value={week} onChange={(e) => set(season, Number(e.target.value))} className="h-8 w-[5.5rem] text-xs sm:w-auto">
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
  const nba = loc.pathname === "/nba" || loc.pathname.startsWith("/nba/");
  useSportTheme(nba);
  const sections = nba ? NBA_SECTIONS : SECTIONS;
  const mobile = nba ? NBA_MOBILE : MOBILE;
  const link = (n: NavItem) => (
    <NavLink
      key={n.to}
      to={n.to + (nba ? "" : suffix)}
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
        <div className="px-2 pb-6"><Logo nba={nba} /></div>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5"><Sections sections={sections} link={link} /></nav>
        <div className="mt-4 rounded-lg border border-line p-3 text-[11px] leading-relaxed text-muted">
          <Activity className="mb-1 h-3.5 w-3.5 text-accent" aria-hidden />
          {nba ? "Basketball" : "Football"} research, not betting advice. No pick is guaranteed.
        </div>
      </aside>
      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <nav className="absolute left-0 top-0 flex h-full w-64 flex-col gap-0.5 bg-surface p-3">
            <div className="mb-4 flex items-center justify-between px-2"><Logo nba={nba} /><button aria-label="Close menu" onClick={() => setOpen(false)}><X className="h-5 w-5" /></button></div>
            <Sections sections={sections} link={link} />
          </nav>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 sm:gap-3 border-b border-line bg-bg/85 px-3 backdrop-blur sm:px-6">
          <button className="lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></button>
          {/* On phones the NFL/NBA switch stands in for the logo so the header fits. */}
          <div className="hidden sm:block lg:hidden"><Logo compact nba={nba} /></div>
          <SportSwitch nba={nba} />
          <div className="flex-1" />
          {!nba && <SeasonWeekPicker />}
          {!nba && <div className="hidden sm:block"><StatusChip /></div>}
          <ThemeToggle />
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-24 pt-5 sm:px-6 lg:pb-10">
          <Outlet />
        </main>
      </div>
      {/* Mobile bottom nav */}
      <nav aria-label="Primary mobile" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 backdrop-blur lg:hidden">
        {mobile.map((n) => (
          <NavLink key={n.to} to={n.to + (nba ? "" : suffix)} end={n.end}
            className={({ isActive }) => cn("flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium", isActive ? "text-accent" : "text-muted")}>
            <n.icon className="h-5 w-5" aria-hidden />
            {n.short ?? n.label}
          </NavLink>
        ))}
        <button onClick={() => setOpen(true)} className="flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium text-muted">
          <Menu className="h-5 w-5" aria-hidden />More
        </button>
      </nav>
    </div>
  );
}

function Sections({ sections, link }: { sections: typeof SECTIONS; link: (n: NavItem) => React.ReactNode }) {
  return (
    <>
      {sections.map((s, i) => (
        <div key={s.title || i} className={cn(i > 0 && "mt-4", !s.title && "mt-auto border-t border-line pt-3")}>
          {s.title && <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted/80">{s.title}</div>}
          <div className="flex flex-col gap-0.5">{s.items.map(link)}</div>
        </div>
      ))}
    </>
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
