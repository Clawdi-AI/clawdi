import asyncio
from functools import lru_cache
from pathlib import Path
from typing import Protocol

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError

from app.core.config import settings


class FileStore(Protocol):
    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def delete(self, key: str) -> None: ...
    async def exists(self, key: str) -> bool: ...


class LocalFileStore:
    """File store backed by local filesystem.

    All methods wrap the blocking syscalls in `asyncio.to_thread` so they
    don't stall the event loop under concurrent load.
    """

    def __init__(self, base_path: str):
        self.base_path = Path(base_path).resolve()

    def _path(self, key: str) -> Path:
        # Defense-in-depth path-traversal guard. The route layer
        # already validates skill_key / local_session_id against
        # safe-character patterns, but a future caller forgetting
        # that check, or a derived key passed unsanitised, would
        # otherwise escape the configured base via ".." segments.
        # `resolve()` collapses all relative components, then we
        # confirm the result still lives under base. Belt-and-
        # braces, cheap, no behavior change for legitimate keys.
        candidate = (self.base_path / key).resolve()
        if not candidate.is_relative_to(self.base_path):
            raise ValueError(f"file-store key escapes base path: {key!r}")
        return candidate

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        del content_type

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


class S3FileStore:
    """File store backed by S3-compatible object storage."""

    def __init__(
        self,
        *,
        bucket: str,
        region: str,
        endpoint_url: str,
        access_key_id: str,
        secret_access_key: str,
        force_path_style: bool = False,
    ):
        if not bucket:
            raise RuntimeError("FILE_STORE_S3_BUCKET is required when FILE_STORE_TYPE=s3")
        self.bucket = bucket
        config = BotoConfig(
            s3={"addressing_style": "path" if force_path_style else "auto"},
        )
        kwargs = {
            "service_name": "s3",
            "region_name": region or None,
            "endpoint_url": endpoint_url or None,
            "config": config,
        }
        if access_key_id or secret_access_key:
            kwargs["aws_access_key_id"] = access_key_id
            kwargs["aws_secret_access_key"] = secret_access_key
        self.client = boto3.client(**kwargs)

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        extra: dict[str, str] = {}
        if content_type:
            extra["ContentType"] = content_type
        await asyncio.to_thread(
            self.client.put_object,
            Bucket=self.bucket,
            Key=key,
            Body=data,
            **extra,
        )

    async def get(self, key: str) -> bytes:
        def _read() -> bytes:
            try:
                response = self.client.get_object(Bucket=self.bucket, Key=key)
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code")
                if code in {"404", "NoSuchKey", "NotFound"}:
                    raise FileNotFoundError(key) from exc
                raise
            body = response["Body"]
            try:
                return body.read()
            finally:
                body.close()

        return await asyncio.to_thread(_read)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self.client.delete_object, Bucket=self.bucket, Key=key)

    async def exists(self, key: str) -> bool:
        def _exists() -> bool:
            try:
                self.client.head_object(Bucket=self.bucket, Key=key)
                return True
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code")
                if code in {"404", "NoSuchKey", "NotFound"}:
                    return False
                raise

        return await asyncio.to_thread(_exists)


@lru_cache(maxsize=1)
def get_file_store() -> FileStore:
    """Return the configured FileStore.

    Single factory read from `Settings`. Cached so route modules reuse
    the same local path / S3 client.
    """
    kind = getattr(settings, "file_store_type", "local")
    if kind == "local":
        return LocalFileStore(settings.file_store_local_path)
    if kind == "s3":
        return S3FileStore(
            bucket=settings.file_store_s3_bucket,
            region=settings.file_store_s3_region,
            endpoint_url=settings.file_store_s3_endpoint_url,
            access_key_id=settings.file_store_s3_access_key_id,
            secret_access_key=settings.file_store_s3_secret_access_key,
            force_path_style=settings.file_store_s3_force_path_style,
        )
    raise RuntimeError(f"Unknown FILE_STORE_TYPE={kind!r}. Expected 'local' or 's3'.")
