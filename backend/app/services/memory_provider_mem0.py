"""Narrow adapter for the optional, untyped Mem0 client.

``mem0ai`` 2.0.14 exports ``MemoryClient`` from ``mem0`` but does not publish
``py.typed``. Keep the official lazy import and every SDK call in this
standard-mode adapter, then validate responses into first-party domain records.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import TypeGuard

import httpx
from pydantic import BaseModel, ConfigDict, Field, JsonValue, RootModel, ValidationError

from app.services.memory_types import (
    MemoryItem,
    MemoryProviderUnavailableError,
    MemoryProviderUpstreamError,
)

type JsonObject = dict[str, JsonValue]


class _Mem0WireModel(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True, hide_input_in_errors=True)


class _Mem0AddItem(_Mem0WireModel):
    id: str = Field(min_length=1, pattern=r".*\S.*")


class _Mem0AddResponse(_Mem0WireModel):
    results: list[_Mem0AddItem] = Field(min_length=1)


class _Mem0Metadata(_Mem0WireModel):
    category: str = Field(default="fact", min_length=1)
    tags: list[str] | None = None
    source_session_id: str | None = None
    source_environment_id: str | None = None


class _Mem0Item(_Mem0WireModel):
    id: str = Field(min_length=1, pattern=r".*\S.*")
    memory: str
    metadata: _Mem0Metadata = Field(default_factory=_Mem0Metadata)
    created_at: str | None = None


class _Mem0SearchResponse(_Mem0WireModel):
    results: list[_Mem0Item]


class _Mem0ListResponse(_Mem0WireModel):
    count: int = Field(ge=0)
    results: list[_Mem0Item]


class _Mem0CountResponse(_Mem0WireModel):
    count: int = Field(ge=0)


class _Mem0GetResponse(_Mem0WireModel):
    id: str = Field(min_length=1, pattern=r".*\S.*")
    user_id: str = Field(min_length=1, pattern=r".*\S.*")


class _Mem0DeleteResponse(RootModel[dict[str, JsonValue]]):
    """The pinned client documents delete as one JSON object, consumed for success only."""


def _is_exception_type(value: object) -> TypeGuard[type[Exception]]:
    return isinstance(value, type) and issubclass(value, Exception)


def mem0_available() -> bool:
    """Return whether the pinned public SDK exports are usable."""

    try:
        from mem0 import MemoryClient
        from mem0.exceptions import MemoryError, NetworkError, RateLimitError
    except ImportError:
        return False
    return callable(MemoryClient) and all(
        _is_exception_type(error_type) for error_type in (MemoryError, NetworkError, RateLimitError)
    )


class Mem0Provider:
    """Memory provider backed by the optional Mem0 Platform client."""

    def __init__(self, api_key: str, *, http_client: httpx.Client | None = None):
        try:
            from mem0 import MemoryClient
            from mem0.exceptions import MemoryError, NetworkError, RateLimitError
        except ImportError as exc:
            raise MemoryProviderUnavailableError("Mem0 SDK is unavailable") from exc
        if not callable(MemoryClient) or not (
            _is_exception_type(MemoryError)
            and _is_exception_type(NetworkError)
            and _is_exception_type(RateLimitError)
        ):
            raise MemoryProviderUnavailableError("Mem0 SDK is unavailable")
        try:
            if http_client is None:
                client = MemoryClient(api_key=api_key)
            else:
                client = MemoryClient(api_key=api_key, client=http_client)
        except (NetworkError, RateLimitError) as exc:
            raise MemoryProviderUnavailableError("Mem0 client is unavailable") from exc
        except MemoryError as exc:
            raise MemoryProviderUnavailableError("Mem0 client initialization failed") from exc
        except httpx.RequestError as exc:
            raise MemoryProviderUnavailableError("Mem0 client is unavailable") from exc
        except (ImportError, AttributeError, TypeError, ValueError) as exc:
            raise MemoryProviderUnavailableError("Mem0 client is incompatible") from exc
        try:
            add_operation: object = client.add
            search_operation: object = client.search
            get_all_operation: object = client.get_all
            get_operation: object = client.get
            delete_operation: object = client.delete
        except AttributeError as exc:
            raise MemoryProviderUnavailableError("Mem0 client is incompatible") from exc
        if not all(
            callable(operation)
            for operation in (
                add_operation,
                search_operation,
                get_all_operation,
                get_operation,
                delete_operation,
            )
        ):
            raise MemoryProviderUnavailableError("Mem0 client is incompatible")
        self._add = add_operation
        self._search = search_operation
        self._get_all = get_all_operation
        self._get = get_operation
        self._delete = delete_operation
        self._error_type = MemoryError
        self._transient_error_types = (NetworkError, RateLimitError)

    async def add(
        self,
        user_id: str,
        content: str,
        category: str = "fact",
        source: str = "manual",
        tags: list[str] | None = None,
        source_session_id: uuid.UUID | None = None,
        source_environment_id: uuid.UUID | None = None,
    ) -> MemoryItem:
        metadata_tags: list[JsonValue] = [tag for tag in tags or []]
        metadata: JsonObject = {
            "category": category,
            "source": source,
            "tags": metadata_tags,
        }
        if source_session_id is not None:
            metadata["source_session_id"] = str(source_session_id)
        if source_environment_id is not None:
            metadata["source_environment_id"] = str(source_environment_id)
        messages: list[dict[str, str]] = [{"role": "user", "content": content}]
        result = self._invoke(
            lambda: self._add(
                messages,
                filters={"user_id": user_id},
                metadata=metadata,
            )
        )
        response = _validate_response(_Mem0AddResponse, result)
        return {"id": response.results[0].id}

    async def search(
        self,
        user_id: str,
        query: str,
        limit: int = 50,
        category: str | None = None,
    ) -> list[MemoryItem]:
        result = self._invoke(
            lambda: self._search(
                query,
                filters=_mem0_filters(user_id, category=category),
                top_k=limit,
            )
        )
        response = _validate_response(_Mem0SearchResponse, result)
        return [
            _serialize_mem0_item(item)
            for item in response.results
            if category is None or item.metadata.category == category
        ]

    async def list_all(
        self,
        user_id: str,
        limit: int = 50,
        offset: int = 0,
        category: str | None = None,
        order: str = "desc",
    ) -> list[MemoryItem]:
        del order
        result = self._invoke(
            lambda: self._get_all(
                filters=_mem0_filters(user_id, category=category),
                page=(offset // limit) + 1,
                page_size=limit,
            )
        )
        response = _validate_response(_Mem0ListResponse, result)
        return [_serialize_mem0_item(item) for item in response.results[:limit]]

    async def count(
        self,
        user_id: str,
        category: str | None = None,
    ) -> int:
        result = self._invoke(
            lambda: self._get_all(
                filters=_mem0_filters(user_id, category=category),
                page=1,
                page_size=1,
            )
        )
        return _validate_response(_Mem0CountResponse, result).count

    async def delete(self, user_id: str, memory_id: str) -> bool:
        memory = _validate_response(
            _Mem0GetResponse,
            self._invoke(lambda: self._get(memory_id)),
        )
        if memory.user_id != user_id:
            return False
        _validate_response(
            _Mem0DeleteResponse,
            self._invoke(lambda: self._delete(memory_id)),
        )
        return True

    def _invoke(self, operation: Callable[[], object]) -> object:
        try:
            return operation()
        except self._transient_error_types as exc:
            raise MemoryProviderUnavailableError("Mem0 request is unavailable") from exc
        except self._error_type as exc:
            raise MemoryProviderUpstreamError("Mem0 request failed") from exc
        except httpx.RequestError as exc:
            raise MemoryProviderUnavailableError("Mem0 request is unavailable") from exc
        except httpx.HTTPStatusError as exc:
            raise MemoryProviderUpstreamError("Mem0 request failed") from exc
        except (TypeError, ValueError) as exc:
            raise MemoryProviderUpstreamError("Mem0 client is incompatible") from exc


def _validate_response[T: BaseModel](model: type[T], result: object) -> T:
    try:
        return model.model_validate(result)
    except ValidationError as exc:
        raise MemoryProviderUpstreamError("Mem0 returned an invalid response") from exc


def _serialize_mem0_item(item: _Mem0Item) -> MemoryItem:
    metadata = item.metadata
    item_tags: list[JsonValue] | None = (
        [tag for tag in metadata.tags] if metadata.tags is not None else None
    )
    return {
        "id": item.id,
        "content": item.memory,
        "category": metadata.category,
        "source": "mem0",
        "tags": item_tags,
        "created_at": item.created_at,
        "source_session_id": metadata.source_session_id,
        "source_environment_id": metadata.source_environment_id,
    }


def _mem0_filters(
    user_id: str,
    *,
    category: str | None,
) -> JsonObject:
    conditions: list[JsonValue] = [{"user_id": user_id}]
    if category is not None:
        conditions.append({"metadata": {"category": category}})
    return {"AND": conditions}


__all__ = ["Mem0Provider", "mem0_available"]
