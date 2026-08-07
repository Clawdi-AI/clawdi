from datetime import date

from pydantic import BaseModel


class ContributionDayResponse(BaseModel):
    date: date
    count: int
    level: int


class DashboardStatsResponse(BaseModel):
    total_sessions: int
    total_messages: int
    total_tokens: int
    active_days: int
    current_streak: int
    longest_streak: int
    peak_hour: int
    favorite_model: str | None
    projects_count: int
    skills_count: int
    memories_count: int
    vault_count: int
    vault_keys_count: int
    connectors_count: int
    manual_sessions_last_7_days: int
    automated_sessions_last_7_days: int
    top_model_last_7_days: str | None
    sessions_today: int
    contribution: list[ContributionDayResponse]
