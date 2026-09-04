from __future__ import annotations

import asyncio
import os
import socket
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
import uvicorn

from app.services.embedding import EMBEDDING_DIM, EmbeddingUpstreamError, LocalServiceEmbedder
from app.workers.embedding import (
    StagedEmbeddingSocket,
    check_embedding_worker_health,
    create_embedding_worker_app,
    stage_embedding_socket,
)


class _RecordingEmbedder:
    def __init__(self, marker: float) -> None:
        self.marker = marker
        self.calls: list[str] = []

    async def embed(self, text: str) -> list[float]:
        self.calls.append(text)
        return [self.marker] + ([0.0] * (EMBEDDING_DIM - 1))


@dataclass
class _RunningGeneration:
    server: uvicorn.Server
    task: asyncio.Task[None]
    staged_socket: StagedEmbeddingSocket

    def publish(self) -> None:
        self.staged_socket.publish()

    async def stop(self) -> None:
        self.server.should_exit = True
        async with asyncio.timeout(2):
            await self.task


@asynccontextmanager
async def _running_generation(
    socket_path: Path,
    embedder: _RecordingEmbedder,
    instance_id: str,
    *,
    publish: bool = True,
) -> AsyncGenerator[_RunningGeneration, None]:
    app = create_embedding_worker_app(
        embedder,
        instance_id=instance_id,
        max_concurrency=1,
    )
    with stage_embedding_socket(str(socket_path)) as staged_socket:
        server = uvicorn.Server(
            uvicorn.Config(
                app,
                workers=1,
                access_log=False,
                log_level="critical",
                lifespan="off",
                timeout_keep_alive=1,
            )
        )
        task = asyncio.create_task(
            server.serve(sockets=[staged_socket.listener]),
            name=f"embedding-worker-test-{instance_id}",
        )
        generation = _RunningGeneration(server, task, staged_socket)
        try:
            async with asyncio.timeout(2):
                while not server.started and not task.done():
                    await asyncio.sleep(0.01)
            if task.done():
                await task
                raise RuntimeError("test embedding worker exited before startup")
            if publish:
                generation.publish()
            yield generation
        finally:
            await generation.stop()


async def test_embedding_worker_rejects_excess_inference_without_queueing() -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    class BlockingEmbedder:
        async def embed(self, text: str) -> list[float]:
            assert text == "first"
            started.set()
            await release.wait()
            return [0.25] * EMBEDDING_DIM

    app = create_embedding_worker_app(
        BlockingEmbedder(),
        instance_id="test-instance",
        max_concurrency=1,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        first = asyncio.create_task(client.post("/v1/embeddings", json={"text": "first"}))
        await asyncio.wait_for(started.wait(), timeout=1)

        rejected = await client.post("/v1/embeddings", json={"text": "second"})
        release.set()
        completed = await asyncio.wait_for(first, timeout=1)

    assert rejected.status_code == 503
    assert rejected.headers["retry-after"] == "1"
    assert rejected.headers["x-clawdi-embedding-rejection"] == "capacity"
    assert completed.status_code == 200
    assert completed.json() == {"embedding": [0.25] * EMBEDDING_DIM}


async def test_embedding_worker_sanitizes_local_provider_failure() -> None:
    class FailingEmbedder:
        async def embed(self, text: str) -> list[float]:
            raise EmbeddingUpstreamError(f"private provider detail: {text}")

    app = create_embedding_worker_app(
        FailingEmbedder(),
        instance_id="test-instance",
        max_concurrency=1,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/v1/embeddings", json={"text": "secret"})

    assert response.status_code == 503
    assert response.json() == {"detail": "Embedding service temporarily unavailable"}
    assert "private provider detail" not in response.text


async def test_local_service_transport_reconnects_to_published_uds_generation(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    socket_path = tmp_path_factory.mktemp("uds") / "embedding.sock"
    old_embedder = _RecordingEmbedder(1.0)
    new_embedder = _RecordingEmbedder(2.0)
    client = LocalServiceEmbedder(str(socket_path), 2)

    try:
        async with _running_generation(
            socket_path,
            old_embedder,
            "old-instance",
        ) as old_generation:
            assert (await client.embed("before-rollover"))[0] == 1.0
            async with _running_generation(socket_path, new_embedder, "new-instance"):
                assert (await client.embed("after-publish"))[0] == 2.0
                await old_generation.stop()
                assert (await client.embed("after-retire"))[0] == 2.0
    finally:
        await client.aclose()

    assert old_embedder.calls == ["before-rollover"]
    assert new_embedder.calls == ["after-publish", "after-retire"]


async def test_embedding_healthcheck_requires_published_instance_identity(
    tmp_path_factory: pytest.TempPathFactory,
) -> None:
    socket_path = tmp_path_factory.mktemp("health-uds") / "embedding.sock"
    old_embedder = _RecordingEmbedder(1.0)
    new_embedder = _RecordingEmbedder(2.0)

    async with _running_generation(socket_path, old_embedder, "old-instance"):
        assert await check_embedding_worker_health(str(socket_path), "old-instance")
        async with _running_generation(
            socket_path,
            new_embedder,
            "new-instance",
            publish=False,
        ) as new_generation:
            assert not await check_embedding_worker_health(str(socket_path), "new-instance")
            new_generation.publish()
            assert await check_embedding_worker_health(str(socket_path), "new-instance")
            assert not await check_embedding_worker_health(str(socket_path), "old-instance")


def test_embedding_socket_rollover_does_not_let_old_owner_remove_new_socket(
    tmp_path: Path,
) -> None:
    socket_directory = tmp_path / "run"
    socket_path = socket_directory / "embedding.sock"
    old_context = stage_embedding_socket(str(socket_path))
    new_context = stage_embedding_socket(str(socket_path))

    old_socket = old_context.__enter__()
    old_socket.publish()
    old_inode = os.lstat(socket_path).st_ino
    new_socket = new_context.__enter__()
    assert os.lstat(socket_path).st_ino == old_inode
    new_socket.publish()
    new_inode = os.lstat(socket_path).st_ino
    try:
        assert old_inode != new_inode
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(str(socket_path))
            connection, _address = new_socket.listener.accept()
            connection.close()
        old_context.__exit__(None, None, None)
        assert socket_path.exists()
        assert os.lstat(socket_path).st_ino == new_inode
    finally:
        new_context.__exit__(None, None, None)

    assert not socket_path.exists()


def test_embedding_socket_failed_rollout_keeps_published_socket(tmp_path: Path) -> None:
    socket_path = tmp_path / "run" / "embedding.sock"
    with stage_embedding_socket(str(socket_path)) as old_socket:
        old_socket.publish()
        old_inode = os.lstat(socket_path).st_ino

        with stage_embedding_socket(str(socket_path)):
            assert os.lstat(socket_path).st_ino == old_inode

        assert os.lstat(socket_path).st_ino == old_inode
