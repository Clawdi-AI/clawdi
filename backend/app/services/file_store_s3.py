"""Narrow synchronous adapter around boto3's dynamically typed S3 client."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Protocol

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError
from botocore.response import StreamingBody
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client


S3_MAX_IN_FLIGHT = 8

_BYTES_ADAPTER = TypeAdapter(bytes)


class S3ObjectStoreClient(Protocol):
    """Typed object operations consumed by the async file-store facade."""

    def put(self, key: str, data: bytes, content_type: str | None = None) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...
    def exists(self, key: str) -> bool: ...
    def list_objects(self, prefix: str, *, start_after: str, limit: int) -> list[S3Object]: ...
    def close(self) -> None: ...


@dataclass(frozen=True)
class S3Object:
    key: str
    last_modified: datetime
    size: int


class _S3ListedObject(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    key: str = Field(alias="Key")
    last_modified: AwareDatetime = Field(alias="LastModified")
    size: int = Field(alias="Size", ge=0)


class _S3ListResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    contents: list[_S3ListedObject] = Field(default_factory=list, alias="Contents")


class S3ObjectStoreError(RuntimeError):
    """Sanitized provider or protocol failure from the S3 adapter."""


class _S3ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    code: str = Field(alias="Code")


class _S3ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    error: _S3ErrorDetail = Field(alias="Error")


class _S3ResponseMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    http_status_code: int = Field(alias="HTTPStatusCode", ge=200, le=299)


class _S3OperationResponse(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)

    response_metadata: _S3ResponseMetadata = Field(alias="ResponseMetadata")


class _S3GetObjectResponse(BaseModel):
    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        extra="ignore",
        strict=True,
    )

    body: StreamingBody = Field(alias="Body")


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
        self._client: S3Client
        config = BotoConfig(
            connect_timeout=5,
            read_timeout=10,
            retries={"mode": "standard", "total_max_attempts": 2},
            max_pool_connections=S3_MAX_IN_FLIGHT,
            s3={"addressing_style": "path" if force_path_style else "auto"},
        )
        try:
            if access_key_id or secret_access_key:
                self._client = boto3.client(
                    "s3",
                    region_name=region or None,
                    endpoint_url=endpoint_url or None,
                    aws_access_key_id=access_key_id,
                    aws_secret_access_key=secret_access_key,
                    config=config,
                )
            else:
                self._client = boto3.client(
                    "s3",
                    region_name=region or None,
                    endpoint_url=endpoint_url or None,
                    config=config,
                )
        except BotoCoreError as exc:
            raise S3ObjectStoreError("S3 client initialization failed") from exc

    def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        try:
            if content_type:
                response = self._client.put_object(
                    Bucket=self._bucket,
                    Key=key,
                    Body=data,
                    ContentType=content_type,
                )
            else:
                response = self._client.put_object(Bucket=self._bucket, Key=key, Body=data)
        except (BotoCoreError, ClientError) as exc:
            raise S3ObjectStoreError("S3 object write failed") from exc
        _validate_operation_response(response, operation="write")

    def get(self, key: str) -> bytes:
        try:
            response = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if _is_not_found(exc):
                raise FileNotFoundError(key) from exc
            raise S3ObjectStoreError("S3 object read failed") from exc
        except BotoCoreError as exc:
            raise S3ObjectStoreError("S3 object read failed") from exc
        # Own the stream before validating metadata so rejection also closes it.
        try:
            body = _S3GetObjectResponse.model_validate(response).body
        except ValidationError:
            raise S3ObjectStoreError("S3 returned an invalid object body") from None
        try:
            try:
                _S3OperationResponse.model_validate(response)
            except ValidationError:
                raise S3ObjectStoreError("S3 returned an invalid object body") from None
            try:
                raw_data: object = body.read()
            except BotoCoreError as exc:
                raise S3ObjectStoreError("S3 object stream failed") from exc
        finally:
            body.close()
        try:
            return _BYTES_ADAPTER.validate_python(raw_data, strict=True)
        except ValidationError:
            raise S3ObjectStoreError("S3 returned an invalid object body") from None

    def delete(self, key: str) -> None:
        try:
            response = self._client.delete_object(Bucket=self._bucket, Key=key)
        except (BotoCoreError, ClientError) as exc:
            raise S3ObjectStoreError("S3 object delete failed") from exc
        _validate_operation_response(response, operation="delete")

    def exists(self, key: str) -> bool:
        try:
            response = self._client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if _is_not_found(exc):
                return False
            raise S3ObjectStoreError("S3 object metadata check failed") from exc
        except BotoCoreError as exc:
            raise S3ObjectStoreError("S3 object metadata check failed") from exc
        _validate_operation_response(response, operation="metadata check")
        return True

    def list_objects(self, prefix: str, *, start_after: str, limit: int) -> list[S3Object]:
        if not prefix or not 1 <= limit <= 1000:
            raise ValueError("S3 listing requires a prefix and a limit between 1 and 1000")
        try:
            response = self._client.list_objects_v2(
                Bucket=self._bucket, Prefix=prefix, StartAfter=start_after, MaxKeys=limit
            )
        except (BotoCoreError, ClientError) as exc:
            raise S3ObjectStoreError("S3 object listing failed") from exc
        _validate_operation_response(response, operation="listing")
        try:
            listed = _S3ListResponse.model_validate(response)
            if len(listed.contents) > limit:
                raise S3ObjectStoreError("S3 returned an oversized object listing")
        except ValidationError:
            raise S3ObjectStoreError("S3 returned an invalid object listing") from None
        return [S3Object(item.key, item.last_modified, item.size) for item in listed.contents]

    def close(self) -> None:
        try:
            self._client.close()
        except BotoCoreError as exc:
            raise S3ObjectStoreError("S3 client close failed") from exc


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
    try:
        response = _S3ErrorResponse.model_validate(exc.response)
    except ValidationError:
        return False
    return response.error.code in {"404", "NoSuchKey", "NotFound"}


def _validate_operation_response(response: object, *, operation: str) -> None:
    try:
        _S3OperationResponse.model_validate(response)
    except ValidationError:
        raise S3ObjectStoreError(f"S3 returned an invalid {operation} response") from None
