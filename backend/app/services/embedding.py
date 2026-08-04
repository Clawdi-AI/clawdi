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

If mode is misconfigured, embedding is disabled and search falls back
to FTS + trigram inside BuiltinProvider.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Iterable
from numbers import Real
from typing import Protocol

from app.core.config import settings

log = logging.getLogger(__name__)

EMBEDDING_DIM = 768
LOCAL_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"


class Embedder(Protocol):
    async def embed(self, text: str) -> list[float]: ...


class EmbeddingUpstreamError(RuntimeError):
    """Sanitized OpenAI-compatible embedding failure."""


class LocalEmbedder:
    """fastembed with paraphrase-multilingual-mpnet-base-v2 (768 dim, ~1GB ONNX).

    First call downloads the model to the fastembed cache dir. Subsequent
    calls load from disk. Runs on CPU via onnxruntime.
    """

    _instance: LocalEmbedder | None = None

    def __init__(self) -> None:
        from fastembed import TextEmbedding

        # Lazy-load the model. Blocks on first call while downloading (~1GB).
        self.model = TextEmbedding(LOCAL_MODEL_NAME)

    @classmethod
    def get(cls) -> LocalEmbedder:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def embed(self, text: str) -> list[float]:
        def _embed_sync() -> list[float]:
            try:
                values = next(iter(self.model.embed([text])))
            except (OSError, RuntimeError) as exc:
                raise EmbeddingUpstreamError("Local embedding provider request failed") from exc
            except (StopIteration, TypeError, ValueError) as exc:
                raise EmbeddingUpstreamError(
                    "Local embedding provider returned an invalid response"
                ) from exc
            return _validate_embedding(values, provider="Local embedding provider")

        return await asyncio.to_thread(_embed_sync)


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

    Returns None only when the configured mode fails to initialize
    (e.g. api mode without a key). Callers should treat None as
    "fall back to FTS + trigram only".
    """
    mode = (settings.memory_embedding_mode or "local").lower()

    if mode == "local":
        try:
            return LocalEmbedder.get()
        except (OSError, RuntimeError, ValueError) as exc:
            # fastembed 0.8.0 delegates downloads to requests/Hugging Face
            # (their HTTP failures derive from OSError) and model loading to
            # ONNX Runtime (RuntimeError); malformed model metadata is a
            # ValueError. Unexpected programming errors must still surface.
            log.warning("LocalEmbedder failed to initialize: %s", exc)
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
