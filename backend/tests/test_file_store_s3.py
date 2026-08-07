from __future__ import annotations

import threading
from collections.abc import Iterator
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

import pytest

from app.services.file_store import S3FileStore
from app.services.file_store_s3 import S3ObjectStoreError, _validate_operation_response


class _S3CompatibleHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    objects: dict[str, tuple[bytes, str | None]] = {}
    requests: list[tuple[str, str, str | None]] = []
    lock = threading.Lock()

    def log_message(self, format: str, *args: object) -> None:
        del format, args

    def _record(self) -> str:
        path = unquote(urlsplit(self.path).path)
        authorization = self.headers.get("Authorization")
        with self.lock:
            self.requests.append((self.command, path, authorization))
        return path

    def _send_empty(self, status: HTTPStatus) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_error(self, status: HTTPStatus, code: str) -> None:
        payload = (
            f"<Error><Code>{code}</Code><Message>contract response</Message></Error>"
        ).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def do_PUT(self) -> None:
        path = self._record()
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length)
        with self.lock:
            self.objects[path] = (data, self.headers.get("Content-Type"))
        self._send_empty(HTTPStatus.OK)

    def do_GET(self) -> None:
        path = self._record()
        if path.endswith("/truncated"):
            payload = b"short"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Length", str(len(payload) + 1))
            self.end_headers()
            self.wfile.write(payload)
            self.close_connection = True
            return
        if path.endswith("/denied"):
            self._send_error(HTTPStatus.FORBIDDEN, "AccessDenied")
            return
        with self.lock:
            stored = self.objects.get(path)
        if stored is None:
            self._send_error(HTTPStatus.NOT_FOUND, "NoSuchKey")
            return
        data, content_type = stored
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Length", str(len(data)))
        if content_type is not None:
            self.send_header("Content-Type", content_type)
        self.end_headers()
        self.wfile.write(data)

    def do_HEAD(self) -> None:
        path = self._record()
        if path.endswith("/denied"):
            self._send_error(HTTPStatus.FORBIDDEN, "AccessDenied")
            return
        with self.lock:
            stored = self.objects.get(path)
        if stored is None:
            self._send_error(HTTPStatus.NOT_FOUND, "NoSuchKey")
            return
        data, content_type = stored
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Length", str(len(data)))
        if content_type is not None:
            self.send_header("Content-Type", content_type)
        self.end_headers()

    def do_DELETE(self) -> None:
        path = self._record()
        with self.lock:
            self.objects.pop(path, None)
        self._send_empty(HTTPStatus.NO_CONTENT)


@pytest.fixture
def s3_endpoint() -> Iterator[tuple[str, type[_S3CompatibleHandler]]]:
    handler = _S3CompatibleHandler
    handler.objects = {}
    handler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", handler
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def _store(endpoint: str) -> S3FileStore:
    return S3FileStore(
        bucket="contract-bucket",
        region="us-east-1",
        endpoint_url=endpoint,
        access_key_id="contract-access-key",
        secret_access_key="contract-secret-key",
        force_path_style=True,
    )


@pytest.fixture
def s3_store(
    s3_endpoint: tuple[str, type[_S3CompatibleHandler]],
) -> Iterator[tuple[S3FileStore, type[_S3CompatibleHandler]]]:
    endpoint, handler = s3_endpoint
    store = _store(endpoint)
    try:
        yield store, handler
    finally:
        store.client.close()


@pytest.mark.asyncio
async def test_real_boto3_s3_transport_contract(
    s3_store: tuple[S3FileStore, type[_S3CompatibleHandler]],
) -> None:
    store, handler = s3_store

    await store.put("folder/object.txt", b"contract body", content_type="text/plain")
    assert handler.objects["/contract-bucket/folder/object.txt"] == (
        b"contract body",
        "text/plain",
    )
    assert await store.exists("folder/object.txt") is True
    assert await store.get("folder/object.txt") == b"contract body"

    await store.delete("folder/object.txt")
    assert await store.exists("folder/object.txt") is False
    with pytest.raises(FileNotFoundError, match="folder/object.txt"):
        await store.get("folder/object.txt")

    methods = [method for method, _, _ in handler.requests]
    assert methods == ["PUT", "HEAD", "GET", "DELETE", "HEAD", "GET"]
    for _, path, authorization in handler.requests:
        assert path.startswith("/contract-bucket/")
        assert authorization is not None
        assert authorization.startswith("AWS4-HMAC-SHA256 Credential=contract-access-key/")


@pytest.mark.asyncio
async def test_non_not_found_client_errors_are_sanitized(
    s3_store: tuple[S3FileStore, type[_S3CompatibleHandler]],
) -> None:
    store, _ = s3_store

    with pytest.raises(S3ObjectStoreError, match="S3 object read failed") as read_error:
        await store.get("denied")
    with pytest.raises(
        S3ObjectStoreError,
        match="S3 object metadata check failed",
    ) as metadata_error:
        await store.exists("denied")
    assert "AccessDenied" not in str(read_error.value)
    assert "403" not in str(metadata_error.value)


def test_operation_response_metadata_fails_closed() -> None:
    with pytest.raises(S3ObjectStoreError, match="invalid write response"):
        _validate_operation_response({}, operation="write")

    with pytest.raises(S3ObjectStoreError, match="invalid delete response"):
        _validate_operation_response(
            {"ResponseMetadata": {"HTTPStatusCode": 500}},
            operation="delete",
        )


@pytest.mark.asyncio
async def test_streaming_body_closes_after_read_failure(
    s3_store: tuple[S3FileStore, type[_S3CompatibleHandler]],
) -> None:
    store, handler = s3_store

    with pytest.raises(S3ObjectStoreError, match="S3 object stream failed"):
        await store.get("truncated")

    await store.put("after-truncated", b"ok")
    assert await store.exists("after-truncated") is True
    assert [method for method, _, _ in handler.requests] == ["GET", "PUT", "HEAD"]


@pytest.mark.asyncio
async def test_default_credential_chain(
    s3_endpoint: tuple[str, type[_S3CompatibleHandler]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    endpoint, handler = s3_endpoint
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "chain-access-key")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "chain-secret-key")
    store = S3FileStore(
        bucket="contract-bucket",
        region="us-east-1",
        endpoint_url=endpoint,
        access_key_id="",
        secret_access_key="",
        force_path_style=True,
    )
    try:
        await store.put("default-chain", b"credential chain")
    finally:
        store.client.close()

    _, path, authorization = handler.requests[-1]
    assert path == "/contract-bucket/default-chain"
    assert authorization is not None
    assert authorization.startswith("AWS4-HMAC-SHA256 Credential=chain-access-key/")
