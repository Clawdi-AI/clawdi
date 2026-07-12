"""Audit stored AI provider models against the hosted runtime wire contract.

This command is read-only. It checks every unarchived ``ai_providers.models``
value with the same strict schema used by provider writes and runtime manifest
projection. It prints only provider row identifiers, sanitized validation
summaries, and the final invalid-row count.

Usage:
    python -m scripts.audit_ai_provider_models
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, TextIO
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings
from app.models.ai_provider import AiProvider
from app.schemas.ai_provider import AiProviderModel

_MAX_ERRORS_PER_ROW = 8


@dataclass(frozen=True)
class ProviderModelRow:
    id: UUID
    provider_id: str
    models: Any


@dataclass(frozen=True)
class ProviderModelFinding:
    id: UUID
    provider_id: str
    errors: tuple[str, ...]


def _validation_errors(index: int, exc: ValidationError) -> list[str]:
    errors: list[str] = []
    for error in exc.errors(include_input=False, include_url=False):
        if error["type"] == "none_required":
            continue
        location_parts = [
            str(part)
            for part in error["loc"]
            if not (
                isinstance(part, str)
                and (
                    part.startswith("AiProviderModel")
                    or part in {"bool", "float", "int", "list", "none", "str"}
                )
            )
        ]
        location = ".".join(location_parts)
        path = f"models[{index}]"
        if location:
            path = f"{path}.{location}"
        errors.append(f"{path}: {error['msg']}")
    return errors


def audit_provider_model_rows(
    rows: Iterable[ProviderModelRow],
) -> list[ProviderModelFinding]:
    findings: list[ProviderModelFinding] = []
    for row in rows:
        if row.models is None or row.models == []:
            continue
        if not isinstance(row.models, list):
            errors = ["models: Input should be a valid list"]
        else:
            errors = []
            for index, model in enumerate(row.models):
                try:
                    AiProviderModel.model_validate(model)
                except ValidationError as exc:
                    errors.extend(_validation_errors(index, exc))
        if not errors:
            continue
        summarized = errors[:_MAX_ERRORS_PER_ROW]
        if len(errors) > _MAX_ERRORS_PER_ROW:
            summarized.append(f"{len(errors) - _MAX_ERRORS_PER_ROW} additional validation errors")
        findings.append(
            ProviderModelFinding(
                id=row.id,
                provider_id=row.provider_id,
                errors=tuple(summarized),
            )
        )
    return findings


async def load_provider_model_rows(db: AsyncSession) -> list[ProviderModelRow]:
    result = await db.execute(
        select(AiProvider.id, AiProvider.provider_id, AiProvider.models)
        .where(AiProvider.archived_at.is_(None))
        .order_by(AiProvider.id)
    )
    return [
        ProviderModelRow(id=row_id, provider_id=provider_id, models=models)
        for row_id, provider_id, models in result.all()
    ]


def write_report(findings: Iterable[ProviderModelFinding], stream: TextIO) -> int:
    materialized = list(findings)
    for finding in materialized:
        print(
            json.dumps(
                {
                    "id": str(finding.id),
                    "provider_id": finding.provider_id,
                    "errors": finding.errors,
                },
                sort_keys=True,
            ),
            file=stream,
        )
    print(json.dumps({"invalid_count": len(materialized)}, sort_keys=True), file=stream)
    return 1 if materialized else 0


async def _audit_database() -> list[ProviderModelFinding]:
    audit_engine = create_async_engine(
        settings.database_url,
        echo=False,
        hide_parameters=True,
        poolclass=NullPool,
    )
    session_factory = async_sessionmaker(audit_engine, expire_on_commit=False)
    try:
        async with session_factory() as db, db.begin():
            await db.execute(text("SET TRANSACTION READ ONLY"))
            rows = await load_provider_model_rows(db)
        return audit_provider_model_rows(rows)
    finally:
        await audit_engine.dispose()


def main() -> int:
    try:
        findings = asyncio.run(_audit_database())
    except Exception as exc:
        print(
            json.dumps({"audit_error": type(exc).__name__}, sort_keys=True),
            file=sys.stderr,
        )
        return 2
    return write_report(findings, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
