/* College football data: JSON files written by `python -m cfb.pipeline` (site-data/cfb/). The hosted site serves
   them under data/cfb/; the desktop app serves the same files at /api/cfb/. Every number here was published by the
   engine (5,000 simulations per game); nothing is recomputed in the browser. */
import { useQuery } from "@tanstack/react-query";
import { STATIC } from "./api";
import type { Tier } from "./confidence";

export type CfbMarket = "spread" | "total" | "team_total" | "moneyline";
export const MARKET_LABEL: Record<CfbMarket, string> = { spread: "Spread", total: "Game total", team_total: "Team total", moneyline: "Moneyline" };

export type Offer = { price: number; book: string | null };
export type Lean = {
  market: CfbMarket; side: string; team?: string; team_side?: "home" | "away"; line?: number; line_posted?: boolean;
  p: number; score: number; push?: number; tier: string | null; proven: boolean; price?: number; ev?: number;
  best: Offer | null; reasons: string[];
};
export type CfbGame = {
  game_id: number; date: string; week: number; season_type: string; home: string; away: string; home_id: number; away_id: number;
  home_conf: string | null; away_conf: string | null; neutral: boolean; conference_game: boolean; venue: string | null;
  home_rank: number | null; away_rank: number | null; tv: string | null; featured: boolean;
  line: { spread: number | null; total: number | null; ml_home: number | null; ml_away: number | null; tt_home: number | null;
    tt_away: number | null; tt_posted: boolean; source: string | null; fetched_at: string | null; has_line: boolean };
  model: { home: number; away: number; margin: number; total: number; margin_q: number[]; total_q: number[]; home_win: number; line_based: boolean };
  ratings: Record<"home" | "away", { pts_for: number | null; ypp: number | null; plays: number | null; games: number | null }>;
  markets: Lean[];
};
export type CfbPick = Lean & { game_id: number; date: string; home: string; away: string };
export type Week = { generated_at: string; games: CfbGame[]; picks: CfbPick[]; odds: { books_games: number; espn_games: number; no_line: number } };

export type GameTier = Tier & { recent_n: number; recent_rate: number | null; proven: boolean; roi?: number | null; recent_roi?: number | null; avg_price?: number | null };
export type MarketReport = { label: string; tiers: GameTier[]; n: number; rate?: number; roi?: number | null; line: "closing" | "implied" | "usual";
  proven: boolean; by_season: { season: number; n: number; rate?: number; roi?: number }[]; by_side?: Record<string, GameTier[]>; price_range?: number[] };
export type Backtest = {
  first_season: number; last_season: number; games: number; recent_seasons: number[]; break_even: number;
  markets: Record<CfbMarket, MarketReport>; calibration: Record<string, { p: number; actual: number }[]>;
  opening_totals: { n: number; tiers: GameTier[]; by_season: { season: number; n: number; rate: number }[] } | null;
  model: { ratings_half_life_days: number; recency_half_life_seasons: number; sims: number };
};
export type Finding = { market: "spread" | "total" | "moneyline"; pattern: string; side: string; holds: boolean;
  eras: { era: string; n: number; rate?: number | null; roi?: number | null }[] };
export type Findings = { rules: Finding[]; break_even: number };
export type Team = { team_id: number; team: string; conference: string | null; w: number; l: number; ats_w: number; ats_l: number; ats_p: number;
  over: number; under: number; net: number | null; pts_for: number | null; pts_against: number | null; ypp_for: number | null;
  ypp_against: number | null; plays: number | null; power_rank: number };
export type Teams = { season: number; teams: Team[] };
export type PropRow = { game_id: number; player: string; player_id: string; team: string; opp: string; market: string; label: string;
  mean: number; line: number; line_source: "book" | "usual"; p_over: number; side: "over" | "under"; p: number; score: number;
  tier: string | null; proven: boolean; recent: number[]; best: Offer | null };
export type Props = { generated_at: string; rows: PropRow[]; backtest: { markets: Record<string, MarketReport>; note: string } };
export type CfbRecord = { games: number; picks: number; empty_reason?: string; first_date?: string; last_date?: string;
  by_market_tier?: { market: CfbMarket; tier: string | null; n: number; hits: number; rate: number; roi: number | null }[];
  suggested?: { n: number; hits: number; rate: number | null };
  recent?: { game_id: number; date: string; market: CfbMarket; tier: string; p: number; won: number; label: string; side: string; line: number | null }[] };
export type CfbStatus = { generated_at: string; season: number; games_this_week: number; picks: number; props: number;
  history: { first_season: number; games: number; lined_games: number; last_game_date: string }; proven: Record<CfbMarket, string[]> };

const BASE = `${import.meta.env.BASE_URL}data/cfb/`;

export async function cfbGet<T>(name: string): Promise<T> {
  const url = STATIC ? BASE + name : `/api/cfb/${name}`;
  const r = await fetch(url);
  if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error("College football numbers are not published yet.");
  return r.json() as Promise<T>;
}

export function useCfb<T>(name: string, enabled = true) {
  return useQuery({ queryKey: ["cfb", name], queryFn: () => cfbGet<T>(name), staleTime: 5 * 60_000, enabled });
}

export const fmtPrice = (p: number | null | undefined) => (p == null ? "" : p > 0 ? `+${p}` : String(p));
export const fmtLine = (v: number) => (v > 0 ? `+${v}` : v === 0 ? "PK" : String(v));
export const BOOK_NAMES: Record<string, string> = { draftkings: "DraftKings", fanduel: "FanDuel", betmgm: "BetMGM", williamhill_us: "Caesars",
  espnbet: "ESPN BET", fanatics: "Fanatics", betrivers: "BetRivers", hardrockbet: "Hard Rock", ballybet: "Bally Bet", bovada: "Bovada",
  betonlineag: "BetOnline", mybookieag: "MyBookie", betus: "BetUS", lowvig: "LowVig" };
export const bookName = (k: string | null | undefined) => (k ? BOOK_NAMES[k] ?? k : "");

/** "Alabama -7.5", "Under 55.5", "Georgia team total over 31.5", "Texas ML +135". */
export function pickText(m: Lean): string {
  if (m.market === "spread") return `${m.team} ${fmtLine(m.line!)}`;
  if (m.market === "total") return `${m.side === "over" ? "Over" : "Under"} ${m.line}`;
  if (m.market === "team_total") return `${m.team} ${m.side === "over" ? "over" : "under"} ${m.line}`;
  return `${m.team} ML ${fmtPrice(m.price)}`;
}

export const ranked = (name: string, rank: number | null | undefined) => (rank ? `#${rank} ${name}` : name);
export const kick = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "short" });
export const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/Chicago" });

export function tierOf(r: MarketReport | undefined, name: string | null | undefined): GameTier | null {
  return r?.tiers.find((t) => t.tier === name) ?? null;
}
