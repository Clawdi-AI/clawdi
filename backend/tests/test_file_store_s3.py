from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
from xml.etree.ElementTree import Element, SubElement, tostring

import pytest
from botocore.response import StreamingBody

from app.services.file_store import S3FileStore
from app.services.file_store_s3 import (
    S3ObjectStoreError,
    _Boto3S3ObjectStoreClient,
    _validate_operation_response,
)


class _S3CompatibleHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    objects: dict[str, tuple[bytes, str | None]] = {}
    requests: list[tuple[str, str, str | None]] = []
    modified: dict[str, datetime] = {}
    lock = threading.Lock()
    blocked_started = threading.Event()
    unblock = threading.Event()

    def log_message(self, format: str, *args: object) -> None:
        del format, args

    def _record(self) -> str:
        path = unquote(urlsplit(self.path).path)
        authorization = self.headers.get("Authorization")
        with self.lock:
            self.requests.append((self.command, path, authorization))
        if path.endswith("/blocked"):
            self.blocked_started.set()
            self.unblock.wait(5)
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
        query = parse_qs(urlsplit(self.path).query)
        if query.get("list-type") == ["2"]:
            prefix = query.get("prefix", [""])[0]
            after = query.get("start-after", [""])[0]
            limit = int(query.get("max-keys", ["1000"])[0])
            root = Element("ListBucketResult", xmlns="http://s3.amazonaws.com/doc/2006-03-01/")
            SubElement(root, "Name").text = "contract-bucket"
            with self.lock:
                keys = sorted(
                    key
                    for key in self.objects
                    if key.startswith("/contract-bucket/" + prefix)
                    and key.removeprefix("/contract-bucket/") > after
                )[:limit]
                for key in keys:
                    item = SubElement(root, "Contents")
                    SubElement(item, "Key").text = key.removeprefix("/contract-bucket/")
                    SubElement(item, "LastModified").text = self.modified.get(
                        key, datetime.now(UTC)
                    ).isoformat()
                    SubElement(item, "Size").text = str(len(self.objects[key][0]))
            payload = tostring(root)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path.endswith(("/truncated", "/bad-checksum")):
            payload = b"short"
            length = len(payload) + 1 if path.endswith("/truncated") else len(payload)
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Length", str(length))
            self.send_header("x-amz-checksum-crc32", "AAAAAA==")
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
        if path.endswith("/trickle"):
            for value in data:
                self.wfile.write(bytes([value]))
                self.wfile.flush()
                time.sleep(0.04)
        else:
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
    handler.modified = {}
    handler.requests = []
    handler.blocked_started = threading.Event()
    handler.unblock = threading.Event()
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", handler
    finally:
        handler.unblock.set()
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
@pytest.mark.parametrize("key", ["truncated", "bad-checksum"])
async def test_streaming_body_closes_after_read_failure(
    s3_store: tuple[S3FileStore, type[_S3CompatibleHandler]],
    key: str,
) -> None:
    store, handler = s3_store
    assert isinstance(store.client, _Boto3S3ObjectStoreClient)
    bodies: list[StreamingBody] = []

    def capture_body(parsed: dict[str, object], **kwargs: object) -> None:
        body = parsed["Body"]
        assert isinstance(body, StreamingBody)
        bodies.append(body)

    store.client._client.meta.events.register("after-call.s3.GetObject", capture_body)

    with pytest.raises(S3ObjectStoreError, match="S3 object stream failed"):
        await store.get(key)
    assert len(bodies) == 1
    assert bodies[0]._raw_stream.closed

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


@pytest.mark.asyncio
@pytest.mark.parametrize("metadata", [None, {"HTTPStatusCode": 500}, {"HTTPStatusCode": "200"}])
async def test_stream_closes_when_response_metadata_is_rejected(
    s3_store: tuple[S3FileStore, type[_S3CompatibleHandler]],
    metadata: object,
) -> None:
    store, _ = s3_store
    assert isinstance(store.client, _Boto3S3ObjectStoreClient)
    bodies: list[StreamingBody] = []

    def invalidate_metadata(parsed: dict[str, object], **kwargs: object) -> None:
        body = parsed["Body"]
        assert isinstance(body, StreamingBody)
        bodies.append(body)
        parsed["ResponseMetadata"] = metadata

    await store.put("invalid-metadata", b"unread response body")
    store.client._client.meta.events.register("after-call.s3.GetObject", invalidate_metadata)
    with pytest.raises(S3ObjectStoreError, match="S3 returned an invalid object body"):
        await store.get("invalid-metadata")
    assert len(bodies) == 1
    assert bodies[0]._raw_stream.closed


@pytest.mark.parametrize("operation", ["put", "get", "delete", "exists"])
async def test_s3_total_deadline_bounds_requests_and_keeps_worker_admission(
    s3_endpoint, monkeypatch, operation
):
    from app.services import file_store

    monkeypatch.setattr(file_store, "S3_OPERATION_TIMEOUT_SECONDS", 0.08)
    monkeypatch.setattr(file_store, "S3_MAX_IN_FLIGHT", 1)
    endpoint, handler = s3_endpoint
    store = _store(endpoint)
    handler.objects["/contract-bucket/blocked"] = (b"body", None)
    try:
        async with asyncio.timeout(2):
            with pytest.raises(S3ObjectStoreError, match="deadline exceeded"):
                if operation == "put":
                    await store.put("blocked", b"body")
                elif operation == "get":
                    await store.get("blocked")
                elif operation == "delete":
                    await store.delete("blocked")
                else:
                    await store.exists("blocked")
            assert handler.blocked_started.is_set()
            # The caller timed out, but the actual boto thread still owns the
            # one slot. A second caller must not enter the executor/HTTP pool.
            with pytest.raises(S3ObjectStoreError, match="deadline exceeded"):
                await store.put("must-not-start", b"queued")
            assert len(handler.requests) == 1
            handler.unblock.set()
            # Join actual work before closing its client; retry admission may
            # have to wait for that work, and is part of the same deadline.
            for _ in range(20):
                try:
                    await store.put("recovered", b"recovered")
                    break
                except S3ObjectStoreError:
                    await asyncio.sleep(0.01)
            else:
                pytest.fail("admission did not recover after the worker finished")
            assert handler.objects["/contract-bucket/recovered"][0] == b"recovered"
    finally:
        handler.unblock.set()
        store.client.close()


async def test_s3_trickling_body_cannot_extend_total_deadline(s3_store, monkeypatch):
    from app.services import file_store

    monkeypatch.setattr(file_store, "S3_OPERATION_TIMEOUT_SECONDS", 0.06)
    store, handler = s3_store
    handler.objects["/contract-bucket/trickle"] = (b"abcd", None)
    # Each byte arrives well within botocore's read timeout. Only the outer
    # deadline protects against a continuously progressing slow response.
    async with asyncio.timeout(1):
        with pytest.raises(S3ObjectStoreError, match="deadline exceeded"):
            await store.get("trickle")
    await asyncio.sleep(0.2)
    await store.put("after-trickle", b"ok")
    assert await store.get("after-trickle") == b"ok"


@pytest.mark.committed_db
async def test_snapshot_sweep_retains_live_references_and_recent_objects(
    s3_store, db_session, seed_user, engine
):
    import uuid

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.models.session import Session
    from app.models.session_share import SessionShare
    from app.services.session_snapshot_retention_worker import (
        SNAPSHOT_PREFIX,
        SessionSnapshotRetentionWorker,
    )

    store, handler = s3_store
    now = datetime.now(UTC)

    def key():
        return f"{SNAPSHOT_PREFIX}{seed_user.id}/{uuid.uuid4()}/{'a' * 64}-{uuid.uuid4()}.json"

    current, shared, recently_revoked, orphan, recent = [key() for _ in range(5)]
    for object_key in [current, shared, recently_revoked, orphan, recent, "sessions/legacy.json"]:
        full = "/contract-bucket/" + object_key
        handler.objects[full] = (b"snapshot", None)
        handler.modified[full] = now - timedelta(days=2)
    handler.modified["/contract-bucket/" + recent] = now
    row = Session(
        user_id=seed_user.id, local_session_id="sweep-live", file_key=current, started_at=now
    )
    db_session.add(row)
    await db_session.flush()
    for shared_key, revoked in [(shared, None), (recently_revoked, now - timedelta(hours=1))]:
        db_session.add(
            SessionShare(
                session_id=row.id,
                created_by=seed_user.id,
                scope="session",
                end_position=0,
                source_protocol="snapshot-v1",
                source_revision="snapshot:" + "a" * 64,
                snapshot_file_key=shared_key,
                public_metadata={},
                revoked_at=revoked,
            )
        )
    await db_session.commit()
    worker = SessionSnapshotRetentionWorker(async_sessionmaker(engine), file_store=store)
    assert await worker.run_once(now=now, dry_run=True) == 1
    assert "/contract-bucket/" + orphan in handler.objects
    assert await worker.run_once(now=now) == 1
    assert "/contract-bucket/" + orphan not in handler.objects
    assert await worker.run_once(now=now) == 0
    for keep in [current, shared, recently_revoked, recent, "sessions/legacy.json"]:
        assert "/contract-bucket/" + keep in handler.objects


@pytest.mark.committed_db
async def test_snapshot_sweep_pages_at_most_1000_objects_without_starvation(
    s3_store, engine, seed_user
):
    import uuid

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.services.session_snapshot_retention_worker import (
        SNAPSHOT_PREFIX,
        SessionSnapshotRetentionWorker,
    )

    store, handler = s3_store
    now = datetime.now(UTC)
    session_id = uuid.uuid4()
    for index in range(1001):
        key = f"{SNAPSHOT_PREFIX}{seed_user.id}/{session_id}/{index:064x}-{uuid.uuid4()}.json"
        handler.objects["/contract-bucket/" + key] = (b"old", None)
        handler.modified["/contract-bucket/" + key] = now - timedelta(days=2)
    worker = SessionSnapshotRetentionWorker(async_sessionmaker(engine), file_store=store)
    assert await worker.run_once(now=now, dry_run=True) == 1000
    assert await worker.run_once(now=now, dry_run=True) == 1
    assert await worker.run_once(now=now, dry_run=True) == 1000
    # Dry runs never send DELETE, and use real boto pagination parameters.
    assert [method for method, _, _ in handler.requests] == ["GET", "GET", "GET"]
    assert len(handler.objects) == 1001
