"""Ingest one stored session into XTrace Memory and print the result.

Use this in local or Coolify preview to answer: did the backend call XTrace,
what job id/status came back, and how many memories were mirrored locally?

Usage:
    pdm run python -m scripts.debug_xtrace_session_ingest --session-id <uuid>
    pdm run python -m scripts.debug_xtrace_session_ingest --local-session-id <id> --user-id <uuid>
    pdm run python -m scripts.debug_xtrace_session_ingest --session-id <uuid> --print-response
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.database import engine
from app.models.session import Session
from app.services.file_store import get_file_store
from app.services.xtrace_memory import ingest_xtrace_session_memories, xtrace_memory_configured

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("debug-xtrace-session-ingest")


async def run(
    *,
    session_id: uuid.UUID | None,
    local_session_id: str | None,
    user_id: uuid.UUID | None,
    print_response: bool,
) -> int:
    if not xtrace_memory_configured():
        log.error(
            "XTrace memory is not configured. Set XTRACE_MEMORY_ENABLED=true, "
            "XTRACE_API_KEY, and XTRACE_ORG_ID."
        )
        return 2

    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    async with SessionLocal() as db:
        stmt = select(Session)
        if session_id is not None:
            stmt = stmt.where(Session.id == session_id)
        else:
            stmt = stmt.where(Session.local_session_id == local_session_id)
            if user_id is not None:
                stmt = stmt.where(Session.user_id == user_id)
        rows = (await db.execute(stmt.limit(2))).scalars().all()
        if not rows:
            log.error("session not found")
            return 1
        if len(rows) > 1:
            log.error("local_session_id is ambiguous; pass --user-id or use --session-id")
            return 1

        session = rows[0]
        if not session.file_key:
            log.error("session %s has no uploaded content file", session.id)
            return 1

        data = await get_file_store().get(session.file_key)
        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            log.error("session %s content is not valid JSON", session.id)
            return 1
        if not isinstance(parsed, list):
            log.error("session %s content is not a JSON message list", session.id)
            return 1

        messages: list[dict[str, Any]] = [m for m in parsed if isinstance(m, dict)]
        result = await ingest_xtrace_session_memories(db, session=session, messages=messages)
        if result is None:
            log.error("XTrace ingest skipped; no normalized messages or configuration missing")
            return 1

    output: dict[str, Any] = {
        "session_id": str(session.id),
        "local_session_id": session.local_session_id,
        "job_id": result.job_id,
        "status": result.status,
        "created_ref_count": result.created_ref_count,
        "updated_ref_count": result.updated_ref_count,
        "mirrored_count": result.mirrored_count,
    }
    if print_response:
        output["response"] = result.response
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--session-id", type=str, help="Cloud Session.id UUID.")
    g.add_argument("--local-session-id", type=str, help="Client local_session_id.")
    ap.add_argument("--user-id", type=str, help="Required if local_session_id is ambiguous.")
    ap.add_argument("--print-response", action="store_true", help="Include XTrace response JSON.")
    args = ap.parse_args()

    session_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    try:
        if args.session_id:
            session_id = uuid.UUID(args.session_id)
        if args.user_id:
            user_id = uuid.UUID(args.user_id)
    except ValueError:
        log.error("invalid UUID argument")
        sys.exit(2)

    sys.exit(
        asyncio.run(
            run(
                session_id=session_id,
                local_session_id=args.local_session_id,
                user_id=user_id,
                print_response=args.print_response,
            )
        )
    )


if __name__ == "__main__":
    main()
