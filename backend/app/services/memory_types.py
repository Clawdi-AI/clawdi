"""Shared first-party types for memory provider implementations."""

from typing import Protocol
from uuid import UUID

from pydantic import JsonValue

type MemoryItem = dict[str, JsonValue]


class MemoryProviderError(RuntimeError):
    """Base error for a configured external Memory provider boundary."""


class MemoryProviderUnavailableError(MemoryProviderError):
    """The configured provider or a retryable upstream dependency is unavailable."""


class MemoryProviderUpstreamError(MemoryProviderError):
    """The provider rejected a request or returned an invalid response."""


class MemoryProvider(Protocol):
    async def add(
        self,
        user_id: str,
        content: str,
        category: str = "fact",
        source: str = "manual",
        tags: list[str] | None = None,
        source_session_id: UUID | None = None,
        source_environment_id: UUID | None = None,
    ) -> MemoryItem: ...

    async def search(
        self,
        user_id: str,
        query: str,
        limit: int = 50,
        category: str | None = None,
    ) -> list[MemoryItem]: ...

    async def list_all(
        self,
        user_id: str,
        limit: int = 50,
        offset: int = 0,
        category: str | None = None,
        order: str = "desc",
    ) -> list[MemoryItem]: ...

    async def count(
        self,
        user_id: str,
        category: str | None = None,
    ) -> int: ...

    async def update(self, user_id: str, memory_id: str, content: str) -> bool: ...

    async def delete(self, user_id: str, memory_id: str) -> bool: ...


__all__ = [
    "MemoryItem",
    "MemoryProvider",
    "MemoryProviderError",
    "MemoryProviderUnavailableError",
    "MemoryProviderUpstreamError",
]
