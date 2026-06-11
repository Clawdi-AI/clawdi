"""Cost and quality policy for XTrace memory ingestion."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.core.config import settings


@dataclass(frozen=True)
class XTraceSessionIngestDecision:
    should_ingest: bool
    reason: str | None
    quality: str
    automated: bool
    tiny: bool
    estimated_source_messages: int
    estimated_xtrace_messages: int
    max_messages: int


def decide_xtrace_session_ingest(
    session: Any,
    *,
    max_messages: int | None = None,
) -> XTraceSessionIngestDecision:
    message_count = max(0, int(getattr(session, "message_count", 0) or 0))
    duration_seconds = getattr(session, "duration_seconds", None)
    duration = int(duration_seconds or 0)
    summary = str(getattr(session, "summary", "") or "")
    cap = max(1, max_messages or settings.xtrace_memory_max_messages)
    automated = _is_automated_summary(summary)
    tiny = message_count <= settings.xtrace_memory_low_quality_max_messages or (
        duration > 0 and duration <= settings.xtrace_memory_low_quality_max_duration_seconds
    )
    reason = None
    should_ingest = True
    quality = "normal"

    if automated:
        quality = "automated"
        if settings.xtrace_memory_skip_automated_sessions:
            reason = "automated_session"
            should_ingest = False
    elif tiny:
        quality = "tiny"
        if settings.xtrace_memory_skip_tiny_sessions:
            reason = "tiny_session"
            should_ingest = False

    estimated_payload_messages = min(message_count, cap)
    return XTraceSessionIngestDecision(
        should_ingest=should_ingest,
        reason=reason,
        quality=quality,
        automated=automated,
        tiny=tiny,
        estimated_source_messages=message_count,
        estimated_xtrace_messages=estimated_payload_messages + 1,
        max_messages=cap,
    )


def xtrace_skip_response(
    decision: XTraceSessionIngestDecision,
    *,
    reason: str | None = None,
    budget: dict[str, Any] | None = None,
) -> dict[str, Any]:
    skip_reason = reason or decision.reason
    response: dict[str, Any] = {
        "skipped_at": datetime.now(UTC).isoformat(),
        "skip_reason": skip_reason,
        "policy": xtrace_policy_response(decision),
        "_clawdi": {
            "cost": {
                "estimated_source_messages": decision.estimated_source_messages,
                "estimated_xtrace_messages": decision.estimated_xtrace_messages,
                "accounted_xtrace_messages": 0,
            }
        },
    }
    if budget is not None:
        response["budget"] = budget
    return response


def xtrace_policy_response(decision: XTraceSessionIngestDecision) -> dict[str, Any]:
    return {
        "quality": decision.quality,
        "automated": decision.automated,
        "tiny": decision.tiny,
        "estimated_source_messages": decision.estimated_source_messages,
        "estimated_xtrace_messages": decision.estimated_xtrace_messages,
        "max_messages": decision.max_messages,
    }


def _is_automated_summary(summary: str) -> bool:
    return summary.startswith("Cron:") or summary.startswith("[")
