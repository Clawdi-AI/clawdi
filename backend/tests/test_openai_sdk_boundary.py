from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import fastembed
import pytest
from openai import AsyncOpenAI
from pydantic import ValidationError

from app.services.embedding import (
    EMBEDDING_DIM,
    ApiEmbedder,
    EmbeddingUpstreamError,
    LocalEmbedder,
)
from app.services.memory_extraction import (
    MemoryExtractionUpstreamError,
    extract_memories_from_session,
)


class _OpenAICompatibleHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, bytes]] = []
    embedding: list[float] = [0.25] * EMBEDDING_DIM
    embedding_status = HTTPStatus.OK
    completion_content: str | None = json.dumps(
        {
            "memories": [
                {
                    "content": "Uses hermetic SDK boundary tests",
                    "category": "pattern",
                    "tags": ["testing"],
                }
            ]
        }
    )
    completion_choices = 1
    completion_status = HTTPStatus.OK

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        content_length = int(self.headers["Content-Length"])
        self.requests.append((self.path, self.rfile.read(content_length)))
        if self.path == "/v1/embeddings":
            status_code = self.embedding_status
            payload: object = (
                {
                    "object": "list",
                    "data": [
                        {
                            "object": "embedding",
                            "index": 0,
                            "embedding": self.embedding,
                        }
                    ],
                    "model": "compatible-embedding-model",
                    "usage": {"prompt_tokens": 1, "total_tokens": 1},
                }
                if status_code == HTTPStatus.OK
                else {"error": {"message": "upstream failure", "type": "server_error"}}
            )
        else:
            status_code = self.completion_status
            payload = (
                {
                    "id": "chatcmpl-local",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "compatible-chat-model",
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {
                                "role": "assistant",
                                "content": self.completion_content,
                            },
                        }
                    ]
                    * self.completion_choices,
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
                if status_code == HTTPStatus.OK
                else {"error": {"message": "upstream failure", "type": "server_error"}}
            )
        body = json.dumps(payload).encode()
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass


@contextmanager
def _openai_compatible_server(
    *,
    embedding: list[float] | None = None,
    embedding_status: HTTPStatus = HTTPStatus.OK,
    completion_content: str | None = _OpenAICompatibleHandler.completion_content,
    completion_choices: int = 1,
    completion_status: HTTPStatus = HTTPStatus.OK,
) -> Iterator[str]:
    _OpenAICompatibleHandler.requests = []
    _OpenAICompatibleHandler.embedding = embedding or [0.25] * EMBEDDING_DIM
    _OpenAICompatibleHandler.embedding_status = embedding_status
    _OpenAICompatibleHandler.completion_content = completion_content
    _OpenAICompatibleHandler.completion_choices = completion_choices
    _OpenAICompatibleHandler.completion_status = completion_status
    server = ThreadingHTTPServer(("127.0.0.1", 0), _OpenAICompatibleHandler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.asyncio
async def test_public_sdk_surface_supports_openai_compatible_boundaries() -> None:
    with _openai_compatible_server() as base_url:
        embedder = ApiEmbedder("test-key", base_url, "compatible-embedding-model")
        client = AsyncOpenAI(api_key="test-key", base_url=base_url)
        embedding = await embedder.embed("hello")
        assert len(embedding) == EMBEDDING_DIM
        assert embedding == [0.25] * EMBEDDING_DIM
        memories = await extract_memories_from_session(
            [{"role": "user", "content": ["keep", {"nested": True}]}],
            project_path="/workspace",
            client=client,
            model="compatible-chat-model",
        )

    assert memories[0].content == "Uses hermetic SDK boundary tests"
    assert client.is_closed
    assert [path for path, _body in _OpenAICompatibleHandler.requests] == [
        "/v1/embeddings",
        "/v1/chat/completions",
    ]
    embedding_body = _OpenAICompatibleHandler.requests[0][1]
    completion_body = _OpenAICompatibleHandler.requests[1][1]
    assert b'"dimensions":768' in embedding_body
    assert b'"type":"json_schema"' in completion_body
    assert b'"strict":true' in completion_body


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "embedding",
    [
        [0.25] * (EMBEDDING_DIM - 1),
        [0.25] * (EMBEDDING_DIM - 1) + [float("nan")],
    ],
)
async def test_embedding_rejects_malformed_provider_vectors(embedding: list[float]) -> None:
    with _openai_compatible_server(embedding=embedding) as base_url:
        embedder = ApiEmbedder("test-key", base_url, "compatible-embedding-model")
        with pytest.raises(EmbeddingUpstreamError, match="invalid response"):
            await embedder.embed("hello")


@pytest.mark.asyncio
async def test_embedding_maps_sdk_status_errors() -> None:
    with _openai_compatible_server(embedding_status=HTTPStatus.SERVICE_UNAVAILABLE) as base_url:
        embedder = ApiEmbedder("test-key", base_url, "compatible-embedding-model")
        with pytest.raises(EmbeddingUpstreamError, match="request failed"):
            await embedder.embed("hello")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "values",
    [
        [0.25] * (EMBEDDING_DIM - 1),
        [0.25] * (EMBEDDING_DIM - 1) + [float("nan")],
        [False] * EMBEDDING_DIM,
        ["not-a-number"] * EMBEDDING_DIM,
    ],
)
async def test_local_embedding_rejects_malformed_sdk_vectors(
    monkeypatch: pytest.MonkeyPatch,
    values: list[object],
) -> None:
    class FakeTextEmbedding:
        def __init__(self, model_name: str) -> None:
            assert model_name == "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"

        def embed(self, documents: list[str]) -> Iterator[list[object]]:
            assert documents == ["hello"]
            yield values

    monkeypatch.setattr(fastembed, "TextEmbedding", FakeTextEmbedding)

    with pytest.raises(EmbeddingUpstreamError, match="invalid response"):
        await LocalEmbedder().embed("hello")


@pytest.mark.asyncio
async def test_local_embedding_maps_sdk_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    class FailingTextEmbedding:
        def __init__(self, model_name: str) -> None:
            assert model_name == "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"

        def embed(self, documents: list[str]) -> Iterator[list[float]]:
            assert documents == ["hello"]
            raise OSError("provider-internal-detail")

    monkeypatch.setattr(fastembed, "TextEmbedding", FailingTextEmbedding)

    with pytest.raises(EmbeddingUpstreamError, match="request failed") as exc_info:
        await LocalEmbedder().embed("hello")
    assert "provider-internal-detail" not in str(exc_info.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("completion_content", "completion_choices"),
    [
        (None, 1),
        ("", 1),
        (json.dumps({"memories": "not-a-list"}), 1),
        (json.dumps({"memories": []}), 0),
    ],
)
async def test_memory_extraction_rejects_malformed_provider_responses(
    completion_content: str | None,
    completion_choices: int,
) -> None:
    with _openai_compatible_server(
        completion_content=completion_content,
        completion_choices=completion_choices,
    ) as base_url:
        client = AsyncOpenAI(api_key="test-key", base_url=base_url)
        with pytest.raises(MemoryExtractionUpstreamError) as exc_info:
            await extract_memories_from_session(
                [{"role": "user", "content": "remember this"}],
                project_path=None,
                client=client,
                model="compatible-chat-model",
            )

    assert exc_info.value.unavailable is False
    assert client.is_closed


@pytest.mark.asyncio
async def test_memory_extraction_maps_provider_unavailability() -> None:
    with _openai_compatible_server(completion_status=HTTPStatus.SERVICE_UNAVAILABLE) as base_url:
        client = AsyncOpenAI(api_key="test-key", base_url=base_url)
        with pytest.raises(MemoryExtractionUpstreamError) as exc_info:
            await extract_memories_from_session(
                [{"role": "user", "content": "remember this"}],
                project_path=None,
                client=client,
                model="compatible-chat-model",
            )

    assert exc_info.value.unavailable is True
    assert client.is_closed


@pytest.mark.asyncio
async def test_memory_extraction_validates_dynamic_session_messages() -> None:
    client = AsyncOpenAI(api_key="test-key", base_url="http://127.0.0.1:1/v1")
    with pytest.raises(ValidationError):
        await extract_memories_from_session(
            [{"role": "user", "content": object()}],
            project_path=None,
            client=client,
            model="compatible-chat-model",
        )
    assert client.is_closed
