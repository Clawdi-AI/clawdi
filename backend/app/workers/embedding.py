from __future__ import annotations

import asyncio
import os
import socket
import stat
import sys
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
import uvicorn
from anyio import CapacityLimiter, WouldBlock
from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, ConfigDict, StrictStr, ValidationError

from app.core.config import settings
from app.core.logging_config import configure_application_logging
from app.services.embedding import (
    Embedder,
    EmbeddingServiceRequest,
    EmbeddingServiceResponse,
    EmbeddingUpstreamError,
    LocalEmbedder,
)

configure_application_logging()


class EmbeddingWorkerHealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["ok"]
    worker: Literal["embedding"]
    instance_id: StrictStr


def current_worker_instance_id() -> str:
    instance_id = socket.gethostname().strip()
    if not instance_id or "\x00" in instance_id:
        raise RuntimeError("embedding worker instance identity is unavailable")
    return instance_id


async def check_embedding_worker_health(
    socket_path: str,
    expected_instance_id: str,
    *,
    timeout_seconds: float = 4,
) -> bool:
    if not expected_instance_id:
        return False
    try:
        async with httpx.AsyncClient(
            base_url="http://localhost",
            transport=httpx.AsyncHTTPTransport(
                uds=socket_path,
                retries=0,
                trust_env=False,
            ),
            timeout=httpx.Timeout(timeout_seconds),
            trust_env=False,
        ) as client:
            response = await client.get("/health")
            response.raise_for_status()
            health = EmbeddingWorkerHealthResponse.model_validate_json(response.content)
    except (httpx.HTTPError, OSError, RuntimeError, ValidationError, ValueError):
        return False
    return health.instance_id == expected_instance_id


def create_embedding_worker_app(
    embedder: Embedder,
    *,
    instance_id: str,
    max_concurrency: int,
) -> FastAPI:
    limiter = CapacityLimiter(max_concurrency)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    async def health() -> EmbeddingWorkerHealthResponse:
        return EmbeddingWorkerHealthResponse(
            status="ok",
            worker="embedding",
            instance_id=instance_id,
        )

    async def embed(body: EmbeddingServiceRequest) -> EmbeddingServiceResponse:
        try:
            limiter.acquire_nowait()
        except WouldBlock:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Embedding capacity temporarily unavailable",
                headers={
                    "Retry-After": "1",
                    "X-Clawdi-Embedding-Rejection": "capacity",
                },
            ) from None

        try:
            result = await embedder.embed(body.text)
        except EmbeddingUpstreamError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Embedding service temporarily unavailable",
            ) from None
        finally:
            limiter.release()

        return EmbeddingServiceResponse(embedding=result)

    app.add_api_route(
        "/health",
        health,
        methods=["GET"],
        response_model=EmbeddingWorkerHealthResponse,
    )
    app.add_api_route(
        "/v1/embeddings",
        embed,
        methods=["POST"],
        response_model=EmbeddingServiceResponse,
    )
    return app


def _is_owned_socket(path_stat: os.stat_result) -> bool:
    return (
        stat.S_ISSOCK(path_stat.st_mode)
        and path_stat.st_uid == os.getuid()
        and path_stat.st_gid == os.getgid()
    )


@dataclass
class StagedEmbeddingSocket:
    listener: socket.socket
    stable_path: Path
    staged_path: Path
    owned: os.stat_result

    def publish(self) -> None:
        try:
            existing = os.lstat(self.stable_path)
        except FileNotFoundError:
            pass
        else:
            if stat.S_ISLNK(existing.st_mode) or not _is_owned_socket(existing):
                raise OSError("unsafe existing embedding socket")

        os.replace(self.staged_path, self.stable_path)
        published = os.lstat(self.stable_path)
        if published.st_dev != self.owned.st_dev or published.st_ino != self.owned.st_ino:
            raise OSError("embedding socket publication failed")


@contextmanager
def stage_embedding_socket(socket_path: str) -> Generator[StagedEmbeddingSocket, None, None]:
    path = Path(socket_path)
    parent = path.parent
    parent.mkdir(mode=0o770, parents=True, exist_ok=True)
    parent_stat = os.lstat(parent)
    if (
        stat.S_ISLNK(parent_stat.st_mode)
        or not stat.S_ISDIR(parent_stat.st_mode)
        or parent.resolve() != parent
        or parent_stat.st_uid != os.getuid()
        or parent_stat.st_gid != os.getgid()
    ):
        raise OSError("unsafe embedding socket directory")

    descriptor, staged_name = tempfile.mkstemp(prefix=".", suffix=".sock", dir=parent)
    os.close(descriptor)
    staged_path = Path(staged_name)
    staged_path.unlink()

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    owned: os.stat_result | None = None
    try:
        listener.bind(str(staged_path))
        os.chmod(staged_path, 0o660)
        owned = os.lstat(staged_path)
        listener.listen(socket.SOMAXCONN)
        listener.setblocking(False)
        yield StagedEmbeddingSocket(
            listener=listener,
            stable_path=path,
            staged_path=staged_path,
            owned=owned,
        )
    finally:
        listener.close()
        for candidate in (staged_path, path):
            try:
                current = os.lstat(candidate)
            except FileNotFoundError:
                continue
            if (
                owned is not None
                and _is_owned_socket(current)
                and current.st_dev == owned.st_dev
                and current.st_ino == owned.st_ino
            ):
                candidate.unlink()


async def run() -> None:
    instance_id = current_worker_instance_id()
    embedder = LocalEmbedder.get()
    await embedder.initialize()
    app = create_embedding_worker_app(
        embedder,
        instance_id=instance_id,
        max_concurrency=settings.memory_embedding_worker_max_concurrency,
    )
    with stage_embedding_socket(settings.memory_embedding_service_socket_path) as staged_socket:
        config = uvicorn.Config(
            app,
            workers=1,
            access_log=False,
        )
        server = uvicorn.Server(config)
        server_task = asyncio.create_task(
            server.serve(sockets=[staged_socket.listener]),
            name="embedding-worker-server",
        )
        while not server.started and not server_task.done():
            await asyncio.sleep(0.01)
        if server_task.done():
            await server_task
            raise RuntimeError("embedding worker exited before startup")

        staged_socket.publish()
        await server_task


def main() -> None:
    args = sys.argv[1:]
    if args == ["healthcheck"]:
        healthy = asyncio.run(
            check_embedding_worker_health(
                settings.memory_embedding_service_socket_path,
                current_worker_instance_id(),
            )
        )
        if not healthy:
            print("embedding worker instance healthcheck failed", file=sys.stderr)
        raise SystemExit(0 if healthy else 1)
    if args:
        print(f"Unsupported embedding worker arguments: {args!r}", file=sys.stderr)
        raise SystemExit(64)
    asyncio.run(run())


if __name__ == "__main__":
    main()
