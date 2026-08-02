"""Narrow synchronous adapter around boto3's dynamically typed S3 client."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError
from botocore.response import StreamingBody


class S3ObjectStoreClient(Protocol):
    """Typed object operations consumed by the async file-store facade."""

    def put(self, key: str, data: bytes, content_type: str | None = None) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...
    def exists(self, key: str) -> bool: ...
    def close(self) -> None: ...


@runtime_checkable
class _BotoS3Client(Protocol):
    """The boto3 S3 methods verified before the dynamic client is retained."""

    def put_object(
        self,
        *,
        Bucket: str,
        Key: str,
        Body: bytes,
        ContentType: str | None = None,
    ) -> object: ...
    def get_object(self, *, Bucket: str, Key: str) -> object: ...
    def delete_object(self, *, Bucket: str, Key: str) -> object: ...
    def head_object(self, *, Bucket: str, Key: str) -> object: ...
    def close(self) -> None: ...


class _Boto3S3ObjectStoreClient:
    def __init__(
        self,
        *,
        bucket: str,
        region: str,
        endpoint_url: str,
        access_key_id: str,
        secret_access_key: str,
        force_path_style: bool,
    ) -> None:
        self._bucket = bucket
        config = BotoConfig(
            s3={"addressing_style": "path" if force_path_style else "auto"},
        )
        if access_key_id or secret_access_key:
            client = boto3.client(
                "s3",
                region_name=region or None,
                endpoint_url=endpoint_url or None,
                aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key,
                config=config,
            )
        else:
            client = boto3.client(
                "s3",
                region_name=region or None,
                endpoint_url=endpoint_url or None,
                config=config,
            )
        if not isinstance(client, _BotoS3Client):
            raise RuntimeError("boto3 returned an invalid S3 client")
        self._client = client

    def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        if content_type:
            self._client.put_object(
                Bucket=self._bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
        else:
            self._client.put_object(Bucket=self._bucket, Key=key, Body=data)

    def get(self, key: str) -> bytes:
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if _is_not_found(exc):
                raise FileNotFoundError(key) from exc
            raise
        if not isinstance(response, dict):
            raise RuntimeError("S3 get_object returned a non-object response")
        body = response.get("Body")
        if not isinstance(body, StreamingBody):
            raise RuntimeError("S3 get_object returned an invalid Body")
        try:
            return body.read()
        finally:
            body.close()

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self._bucket, Key=key)

    def exists(self, key: str) -> bool:
        try:
            self._client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if _is_not_found(exc):
                return False
            raise
        return True

    def close(self) -> None:
        self._client.close()


def create_s3_object_store_client(
    *,
    bucket: str,
    region: str,
    endpoint_url: str,
    access_key_id: str,
    secret_access_key: str,
    force_path_style: bool,
) -> S3ObjectStoreClient:
    return _Boto3S3ObjectStoreClient(
        bucket=bucket,
        region=region,
        endpoint_url=endpoint_url,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        force_path_style=force_path_style,
    )


def _is_not_found(exc: ClientError) -> bool:
    response = exc.response
    if not isinstance(response, dict):
        return False
    error = response.get("Error")
    if not isinstance(error, dict):
        return False
    code = error.get("Code")
    return isinstance(code, str) and code in {"404", "NoSuchKey", "NotFound"}
