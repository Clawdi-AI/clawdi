"""Embedding backend for the Builtin memory provider.

Configured at deployment level via environment variables (see
`app.core.config.Settings.memory_embedding_*`). End users never see this
choice — they just get working semantic search.

- "local" (default) — fastembed ONNX, ~1GB paraphrase-multilingual-
  mpnet-base-v2 (768 dim, 50+ languages, symmetric). First call
  downloads the model; subsequent calls load from disk. No API key
  needed; CPU-only inference via onnxruntime.

- "api" — OpenAI-compatible embeddings. Set MEMORY_EMBEDDING_API_KEY,
  optionally MEMORY_EMBEDDING_BASE_URL (e.g. https://openrouter.ai/api/v1)
  and MEMORY_EMBEDDING_MODEL. `dimensions=768` is passed to the API so
  the on-disk vector column stays dimension-compatible with local mode.

- "local-service" — the same local FastEmbed model hosted by one dedicated
  process and reached over a Unix socket. This keeps the model and ONNX thread
  pool out of each API worker.

If mode is misconfigured, embedding is disabled and search falls back
to FTS + trigram inside BuiltinProvider.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import Iterable, Sequence
from numbers import Real
from typing import TYPE_CHECKING, Protocol

import httpx
from pydantic import BaseModel, ConfigDict, StrictStr, ValidationError

if TYPE_CHECKING:
    from fastembed import TextEmbedding

from app.core.config import settings
from app.services.metrics import embedding_duration, embedding_in_flight, embedding_rejections

log = logging.getLogger(__name__)

EMBEDDING_DIM = 768
LOCAL_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"


class Embedder(Protocol):
    async def embed(self, text: str) -> list[float]: ...


class EmbeddingUpstreamError(RuntimeError):
    """Sanitized OpenAI-compatible embedding failure."""


class EmbeddingServiceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: StrictStr


class EmbeddingServiceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    embedding: Sequence[object]


class LocalEmbedder:
    """fastembed with paraphrase-multilingual-mpnet-base-v2 (768 dim, ~1GB ONNX).

    First call downloads the model to the fastembed cache dir. Subsequent
    calls load from disk. Runs on CPU via onnxruntime.
    """

    _instance: LocalEmbedder | None = None

    def __init__(self) -> None:
        self._model: TextEmbedding | None = None
        self._initialization_task: asyncio.Task[TextEmbedding] | None = None

    @staticmethod
    def _load_model() -> TextEmbedding:
        from fastembed import TextEmbedding

        if settings.memory_embedding_threads > 0:
            return TextEmbedding(LOCAL_MODEL_NAME, threads=settings.memory_embedding_threads)
        return TextEmbedding(LOCAL_MODEL_NAME)

    @classmethod
    def get(cls) -> LocalEmbedder:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def initialize(self) -> TextEmbedding:
        """Load the model once without blocking the event loop."""
        if self._model is not None:
            return self._model

        task = self._initialization_task
        if task is None:
            task = asyncio.create_task(
                asyncio.to_thread(self._load_model),
                name="local-embedder-initialize",
            )
            self._initialization_task = task

        try:
            model = await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.cancelled() and self._initialization_task is task:
                self._initialization_task = None
            # A cancelled waiter does not cancel the shared load.
            raise
        except Exception:
            if self._initialization_task is task:
                self._initialization_task = None
            raise

        self._model = model
        if self._initialization_task is task:
            self._initialization_task = None
        return model

    async def embed(self, text: str) -> list[float]:
        try:
            model = await self.initialize()
        except (OSError, RuntimeError, ValueError) as exc:
            raise EmbeddingUpstreamError("Local embedding provider request failed") from exc

        def _embed_sync() -> list[float]:
            try:
                values = next(iter(model.embed([text])))
            except (OSError, RuntimeError) as exc:
                raise EmbeddingUpstreamError("Local embedding provider request failed") from exc
            except (StopIteration, TypeError, ValueError) as exc:
                raise EmbeddingUpstreamError(
                    "Local embedding provider returned an invalid response"
                ) from exc
            return _validate_embedding(values, provider="Local embedding provider")

        return await asyncio.to_thread(_embed_sync)


class LocalServiceEmbedder:
    """Reusable client for the dedicated local FastEmbed worker."""

    _instance: LocalServiceEmbedder | None = None

    def __init__(
        self,
        socket_path: str,
        timeout_seconds: float,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.socket_path = socket_path
        self.timeout_seconds = timeout_seconds
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(
            base_url="http://localhost",
            transport=httpx.AsyncHTTPTransport(
                uds=socket_path,
                # A pooled connection remains attached to the old listener
                # after an atomic pathname replacement. Reconnect every POST
                # to the currently published socket without automatic retry.
                limits=httpx.Limits(max_keepalive_connections=0),
                retries=0,
                trust_env=False,
            ),
            timeout=httpx.Timeout(timeout_seconds),
            trust_env=False,
        )

    @classmethod
    def get(cls, socket_path: str, timeout_seconds: float) -> LocalServiceEmbedder:
        instance = cls._instance
        if instance is None:
            instance = cls(socket_path, timeout_seconds)
            cls._instance = instance
        elif instance.socket_path != socket_path or instance.timeout_seconds != timeout_seconds:
            raise RuntimeError("Local embedding service configuration changed at runtime")
        return instance

    @classmethod
    async def close_shared(cls) -> None:
        instance = cls._instance
        cls._instance = None
        if instance is not None:
            await instance.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def embed(self, text: str) -> list[float]:
        backend = "local_service"
        started = time.perf_counter()
        outcome = "error"
        embedding_in_flight.labels(backend=backend).inc()
        try:
            try:
                response = await self._client.post(
                    "/v1/embeddings",
                    json=EmbeddingServiceRequest(text=text).model_dump(),
                )
            except httpx.HTTPError as exc:
                outcome = "unavailable"
                raise EmbeddingUpstreamError("Local embedding service request failed") from exc

            if (
                response.status_code == 503
                and response.headers.get("X-Clawdi-Embedding-Rejection") == "capacity"
            ):
                outcome = "rejected"
                embedding_rejections.labels(backend=backend, reason="capacity").inc()
                raise EmbeddingUpstreamError("Local embedding service request rejected")

            try:
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                outcome = "unavailable" if response.status_code >= 500 else "invalid_response"
                raise EmbeddingUpstreamError(
                    "Local embedding service returned an invalid response"
                ) from exc

            try:
                payload = EmbeddingServiceResponse.model_validate_json(response.content)
            except ValidationError as exc:
                outcome = "invalid_response"
                raise EmbeddingUpstreamError(
                    "Local embedding service returned an invalid response"
                ) from exc

            try:
                result = _validate_embedding(
                    payload.embedding,
                    provider="Local embedding service",
                )
            except EmbeddingUpstreamError:
                outcome = "invalid_response"
                raise
            outcome = "success"
            return result
        finally:
            embedding_in_flight.labels(backend=backend).dec()
            embedding_duration.labels(backend=backend, outcome=outcome).observe(
                time.perf_counter() - started
            )


class ApiEmbedder:
    """OpenAI-compatible embeddings (OpenAI, OpenRouter, any compat endpoint)."""

    def __init__(
        self,
        api_key: str,
        base_url: str | None = None,
        model: str = "text-embedding-3-small",
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.model = model

    async def embed(self, text: str) -> list[float]:
        from openai import APIError, AsyncOpenAI

        # `dimensions=768` truncates via Matryoshka (supported by
        # text-embedding-3-*). Providers that don't support it will
        # surface an explicit error rather than silently mismatch dims.
        try:
            async with AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url or None,
            ) as client:
                response = await client.embeddings.create(
                    input=text,
                    model=self.model,
                    dimensions=EMBEDDING_DIM,
                )
        except APIError as exc:
            raise EmbeddingUpstreamError("Embedding provider request failed") from exc
        if len(response.data) != 1:
            raise EmbeddingUpstreamError("Embedding provider returned an invalid response")
        return _validate_embedding(response.data[0].embedding, provider="Embedding provider")


def _validate_embedding(values: Iterable[object], *, provider: str) -> list[float]:
    embedding: list[float] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, Real):
            raise EmbeddingUpstreamError(f"{provider} returned an invalid response")
        normalized = float(value)
        if not math.isfinite(normalized):
            raise EmbeddingUpstreamError(f"{provider} returned an invalid response")
        embedding.append(normalized)
    if len(embedding) != EMBEDDING_DIM:
        raise EmbeddingUpstreamError(f"{provider} returned an invalid response")
    return embedding


def resolve_embedder() -> Embedder | None:
    """Pick the Embedder based on deployment settings (env vars).

    Local model loading remains lazy and happens through
    `LocalEmbedder.initialize`, off the event loop. Returns None for an
    invalid deployment configuration; callers then fall back to FTS + trigram.
    """
    mode = (settings.memory_embedding_mode or "local").lower()

    if mode == "local":
        return LocalEmbedder.get()

    if mode == "local-service":
        try:
            return LocalServiceEmbedder.get(
                settings.memory_embedding_service_socket_path,
                settings.memory_embedding_service_timeout_seconds,
            )
        except (OSError, RuntimeError, ValueError) as exc:
            log.warning("Local embedding service is misconfigured; disabling embedder: %s", exc)
            return None

    if mode == "api":
        if not settings.memory_embedding_api_key:
            log.warning(
                "MEMORY_EMBEDDING_MODE=api but MEMORY_EMBEDDING_API_KEY is empty; "
                "search will fall back to FTS + trigram.",
            )
            return None
        return ApiEmbedder(
            api_key=settings.memory_embedding_api_key,
            base_url=settings.memory_embedding_base_url or None,
            model=settings.memory_embedding_model,
        )

    log.warning("MEMORY_EMBEDDING_MODE=%r is unknown; disabling embedder", mode)
    return None
