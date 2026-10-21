from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Health(BaseModel):
    status: str
    engine_version: str
    data_loaded: bool
    ready: bool
    calibrated: bool


class Reason(BaseModel):
    sign: int
    text: str


class RankingRow(BaseModel):
    rank: int | None
    player_id: str
    player_name: str
    team: str
    position: str
    opponent: str | None
    game_id: str | None
    gameday: str | None = None
    gametime: str | None = None
    is_home: int | None = None
    eligible: bool
    exclusion: str | None
    score: float | None = Field(None, description="Research score: percentile of the ranking metric among eligible players (0-100). Not a probability.")
    p_model: float | None = Field(None, description="Validated P(1+ rush/rec TD). Null unless the model passed the promotion gate.")
    confidence: str | None
    flags: list[str]
    reasons: list[Reason]
    features: dict[str, Any]
    outcome: int | None = None
    participated: int | None = None


class RankingsResponse(BaseModel):
    season: int
    week: int
    run_id: str | None
    model_version: str | None
    calibrated: bool
    as_of: str | None
    data_cutoff: str | None
    total: int
    page: int
    page_size: int
    rows: list[RankingRow]
    fields_available: dict[str, bool]
    empty_reason: str | None = None


class LockLeg(BaseModel):
    player_id: str
    team: str
    odds: str | None = Field(None, description="Optional manual anytime-TD odds, e.g. '+150', '-120' or '2.50'")
    odds_format: Literal["american", "decimal"] | None = None


class LockRequest(BaseModel):
    season: int
    week: int
    legs: list[LockLeg] = Field(..., min_length=1, max_length=3)
    note: str | None = Field(None, max_length=500)


class RefreshRequest(BaseModel):
    download: bool = False
    force: bool = False
    season: int = 2026


