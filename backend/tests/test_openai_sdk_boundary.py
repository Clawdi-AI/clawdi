from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from openai import AsyncOpenAI
from pydantic import ValidationError

from app.services.embedding import ApiEmbedder
from app.services.memory_extraction import extract_memories_from_session


class _OpenAICompatibleHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, bytes]] = []

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        content_length = int(self.headers["Content-Length"])
        self.requests.append((self.path, self.rfile.read(content_length)))
        if self.path == "/v1/embeddings":
            payload = {
                "object": "list",
                "data": [{"object": "embedding", "index": 0, "embedding": [0.25, 0.75]}],
                "model": "compatible-embedding-model",
                "usage": {"prompt_tokens": 1, "total_tokens": 1},
            }
        else:
            payload = {
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
                            "content": json.dumps(
                                {
                                    "memories": [
                                        {
                                            "content": "Uses hermetic SDK boundary tests",
                                            "category": "pattern",
                                            "tags": ["testing"],
                                        }
                                    ]
                                }
                            ),
                        },
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }
        body = json.dumps(payload).encode()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass


@contextmanager
def _openai_compatible_server() -> Iterator[str]:
    _OpenAICompatibleHandler.requests = []
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
        assert await embedder.embed("hello") == [0.25, 0.75]
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
