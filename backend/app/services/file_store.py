import asyncio
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from app.core.config import settings


class FileStore(Protocol):
    async def put(self, key: str, data: bytes) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def delete(self, key: str) -> None: ...
    async def exists(self, key: str) -> bool: ...


class LocalFileStore:
    """File store backed by local filesystem.

    All methods wrap the blocking syscalls in `asyncio.to_thread` so they
    don't stall the event loop under concurrent load.
    """

    def __init__(self, base_path: str):
        self.base_path = Path(base_path)

    def _path(self, key: str) -> Path:
        return self.base_path / key

    async def put(self, key: str, data: bytes) -> None:
        def _write() -> None:
            path = self._path(key)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

        await asyncio.to_thread(_write)

    async def get(self, key: str) -> bytes:
        return await asyncio.to_thread(self._path(key).read_bytes)

    async def delete(self, key: str) -> None:
        def _unlink() -> None:
            path = self._path(key)
            if path.exists():
                path.unlink()

        await asyncio.to_thread(_unlink)

    async def exists(self, key: str) -> bool:
        return await asyncio.to_thread(self._path(key).exists)


@lru_cache(maxsize=1)
def get_file_store() -> FileStore:
    """Return the configured FileStore.

    Single factory read from `Settings`. Today only `local` is implemented
    — S3/R2 stubs can plug in here without touching route modules. Cached
    so we don't rebuild the Path on every request.
    """
    kind = getattr(settings, "file_store_type", "local")
    if kind == "local":
        return LocalFileStore(settings.file_store_local_path)
    raise RuntimeError(f"Unknown FILE_STORE_TYPE={kind!r}. Only 'local' is implemented so far.")
