"""Catalog of NFLverse release files the importer understands.

The nine files the handoff calls "required" are pbp/stats 2023-2026 plus roster for the
current season. Schedules, injuries, snap counts and prior-season rosters are enrichment:
they unlock pregame lines, availability and participation, and the app degrades
gracefully (with visible flags) when they are missing.
"""
from __future__ import annotations

from dataclasses import dataclass

RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
LICENSE_NOTE = (
    "nflverse data is published openly by the nflverse project (nflfastR / nflreadr). "
    "Play-by-play derives from NFL Game Statistics & Information System feeds. Review the "
    "nflverse-data release notes and licence (CC-BY 4.0 for nflverse-produced data) before "
    "redistributing. Attribution: nflverse, https://github.com/nflverse/nflverse-data"
)


@dataclass(frozen=True)
class SourceKind:
    kind: str
    url_template: str
    local_template: str
    description: str
    seasonal: bool = True


KINDS: dict[str, SourceKind] = {
    "pbp": SourceKind("pbp", RELEASE_BASE + "/pbp/play_by_play_{year}.csv", "pbp_{year}.csv",
                      "Play-by-play (rush and target events, drives)"),
    "stats": SourceKind("stats", RELEASE_BASE + "/stats_player/stats_player_week_{year}.csv", "stats_{year}.csv",
                        "Weekly player box scores (including zero-TD games)"),
    "roster": SourceKind("roster", RELEASE_BASE + "/weekly_rosters/roster_weekly_{year}.csv", "roster_{year}.csv",
                         "Weekly rosters with status (ACT/INA/RES...)"),
    "injuries": SourceKind("injuries", RELEASE_BASE + "/injuries/injuries_{year}.csv", "injuries_{year}.csv",
                           "Official weekly injury reports (Out/Doubtful/Questionable)"),
    "snaps": SourceKind("snaps", RELEASE_BASE + "/snap_counts/snap_counts_{year}.csv", "snaps_{year}.csv",
                        "Offensive snap counts (participation)"),
    "schedules": SourceKind("schedules", RELEASE_BASE + "/schedules/games.csv", "schedules.csv",
                            "Schedule, kickoff times, results and market spread/total lines", seasonal=False),
}


def plan(season: int = 2026, start_year: int = 2023) -> list[dict]:
    """Ordered import plan: (kind, season, required)."""
    out = []
    for yr in range(start_year, season + 1):
        out.append({"kind": "pbp", "season": yr, "required": True})
        out.append({"kind": "stats", "season": yr, "required": True})
    out.append({"kind": "roster", "season": season, "required": True})
    out.append({"kind": "schedules", "season": 0, "required": False})
    for yr in range(max(start_year + 1, season - 2), season + 1):
        if yr != season:
            out.append({"kind": "roster", "season": yr, "required": False})
        out.append({"kind": "injuries", "season": yr, "required": False})
        out.append({"kind": "snaps", "season": yr, "required": False})
    return out


def url_for(kind: str, season: int) -> str:
    return KINDS[kind].url_template.format(year=season)


def local_name(kind: str, season: int) -> str:
    return KINDS[kind].local_template.format(year=season)
