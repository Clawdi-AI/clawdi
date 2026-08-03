"""Narrow synchronous adapter around boto3's dynamically typed S3 client."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError
from botocore.response import StreamingBody
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client


_BYTES_ADAPTER = TypeAdapter(bytes)


class S3ObjectStoreClient(Protocol):
    """Typed object operations consumed by the async file-store facade."""

    def put(self, key: str, data: bytes, content_type: str | None = None) -> None: ...
    def get(self, key: str) -> bytes: ...
    def delete(self, key: str) -> None: ...
    def exists(self, key: str) -> bool: ...
    def close(self) -> None: ...


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
    response_metadata: _S3ResponseMetadata = Field(alias="ResponseMetadata")


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
        try:
            body = _S3GetObjectResponse.model_validate(response).body
        except ValidationError:
            raise S3ObjectStoreError("S3 returned an invalid object body")
        try:
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
