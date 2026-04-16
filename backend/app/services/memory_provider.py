"""Memory provider interface with Built-in (PG) and Mem0 implementations."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.memory import Memory


class MemoryResult:
    def __init__(self, id: str, content: str, category: str, source: str,
                 tags: list[str] | None, created_at: str, **extra):
        self.id = id
        self.content = content
        self.category = category
        self.source = source
        self.tags = tags
        self.created_at = created_at
        self.extra = extra

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "content": self.content,
            "category": self.category,
            "source": self.source,
            "tags": self.tags,
            "created_at": self.created_at,
            **self.extra,
        }


class MemoryProvider(Protocol):
    async def add(self, user_id: str, content: str, category: str = "fact",
                  source: str = "manual", tags: list[str] | None = None) -> dict: ...

    async def search(self, user_id: str, query: str, limit: int = 50) -> list[dict]: ...

    async def list_all(self, user_id: str, limit: int = 50, offset: int = 0,
                       category: str | None = None) -> list[dict]: ...

    async def delete(self, user_id: str, memory_id: str) -> None: ...


class BuiltinProvider:
    """Memory provider backed by PostgreSQL."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def add(self, user_id: str, content: str, category: str = "fact",
                  source: str = "manual", tags: list[str] | None = None) -> dict:
        memory = Memory(
            user_id=uuid.UUID(user_id),
            content=content,
            category=category,
            source=source,
            tags=tags,
        )
        self.db.add(memory)
        await self.db.commit()
        await self.db.refresh(memory)
        return {"id": str(memory.id)}

    async def search(self, user_id: str, query: str, limit: int = 50) -> list[dict]:
        q = (
            select(Memory)
            .where(Memory.user_id == uuid.UUID(user_id), Memory.content.ilike(f"%{query}%"))
            .order_by(Memory.created_at.desc())
            .limit(limit)
        )
        result = await self.db.execute(q)
        return [_memory_to_dict(m) for m in result.scalars().all()]

    async def list_all(self, user_id: str, limit: int = 50, offset: int = 0,
                       category: str | None = None) -> list[dict]:
        q = select(Memory).where(Memory.user_id == uuid.UUID(user_id))
        if category:
            q = q.where(Memory.category == category)
        q = q.order_by(Memory.created_at.desc()).limit(limit).offset(offset)
        result = await self.db.execute(q)
        return [_memory_to_dict(m) for m in result.scalars().all()]

    async def delete(self, user_id: str, memory_id: str) -> None:
        result = await self.db.execute(
            select(Memory).where(
                Memory.id == uuid.UUID(memory_id),
                Memory.user_id == uuid.UUID(user_id),
            )
        )
        memory = result.scalar_one_or_none()
        if memory:
            await self.db.delete(memory)
            await self.db.commit()


class Mem0Provider:
    """Memory provider backed by Mem0 API."""

    def __init__(self, api_key: str):
        from mem0 import MemoryClient
        self.client = MemoryClient(api_key=api_key)

    async def add(self, user_id: str, content: str, category: str = "fact",
                  source: str = "manual", tags: list[str] | None = None) -> dict:
        result = self.client.add(
            [{"role": "user", "content": content}],
            user_id=user_id,
            metadata={"category": category, "source": source, "tags": tags or []},
        )
        mem_id = result[0]["id"] if result else str(uuid.uuid4())
        return {"id": mem_id}

    async def search(self, user_id: str, query: str, limit: int = 50) -> list[dict]:
        results = self.client.search(query, user_id=user_id, limit=limit)
        return [
            {
                "id": r.get("id", ""),
                "content": r.get("memory", ""),
                "category": r.get("metadata", {}).get("category", "fact"),
                "source": "mem0",
                "tags": r.get("metadata", {}).get("tags"),
                "created_at": r.get("created_at", ""),
            }
            for r in results.get("results", results) if isinstance(r, dict)
        ]

    async def list_all(self, user_id: str, limit: int = 50, offset: int = 0,
                       category: str | None = None) -> list[dict]:
        results = self.client.get_all(user_id=user_id)
        items = results if isinstance(results, list) else results.get("results", [])
        if category:
            items = [i for i in items if i.get("metadata", {}).get("category") == category]
        return [
            {
                "id": r.get("id", ""),
                "content": r.get("memory", ""),
                "category": r.get("metadata", {}).get("category", "fact"),
                "source": "mem0",
                "tags": r.get("metadata", {}).get("tags"),
                "created_at": r.get("created_at", ""),
            }
            for r in items[offset:offset + limit]
        ]

    async def delete(self, user_id: str, memory_id: str) -> None:
        self.client.delete(memory_id)


def _memory_to_dict(m: Memory) -> dict:
    return {
        "id": str(m.id),
        "content": m.content,
        "category": m.category,
        "source": m.source,
        "tags": m.tags,
        "access_count": m.access_count,
        "created_at": m.created_at.isoformat(),
    }


async def get_memory_provider(user_id: str, db: AsyncSession) -> MemoryProvider:
    """Resolve the memory provider for a user based on their settings."""
    from app.models.user import UserSetting

    result = await db.execute(
        select(UserSetting).where(UserSetting.user_id == uuid.UUID(user_id))
    )
    setting = result.scalar_one_or_none()
    provider_name = "builtin"
    if setting and setting.settings:
        provider_name = setting.settings.get("memory_provider", "builtin")

    if provider_name == "mem0":
        api_key = setting.settings.get("mem0_api_key", "") if setting else ""
        if not api_key:
            return BuiltinProvider(db)
        return Mem0Provider(api_key=api_key)

    return BuiltinProvider(db)
