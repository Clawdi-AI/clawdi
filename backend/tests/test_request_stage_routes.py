"""Actual ASGI routes; upload uses real API-key auth/PG/local storage.

Connector auth and route-facing adapter calls are mocked explicitly; these
contracts measure attribution, not vendor HTTP or performance improvement.
"""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.core.auth import AuthContext, require_user_auth_short_session
from app.core.database import get_session
from app.middleware import request_timing
from app.models.session import Session
from app.models.user import User
from app.routes import connectors, sessions
from app.schemas.connector import ConnectorAvailableAppResponse
from app.services.api_key import mint_api_key
from app.services.composio import ComposioProtocolError
from app.services.file_store import LocalFileStore


@pytest.mark.parametrize(
    "failure", [None, "lookup", "analysis", "storage", "index", "commit", "cas", "auth"]
)
async def test_upload_stages_real_auth_pg(
    db_session, seed_user, tmp_path, monkeypatch, caplog, failure
):
    elapsed = 0.0
    body_elapsed = 0.0
    monkeypatch.setattr(request_timing, "time", SimpleNamespace(perf_counter=lambda: elapsed))

    async def database_dependency():
        nonlocal elapsed
        elapsed += 0.013
        return db_session

    app = FastAPI()
    app.include_router(sessions.router, prefix="/v1")
    app.dependency_overrides[get_session] = database_dependency
    minted = await mint_api_key(
        db_session,
        user_id=seed_user.id,
        label="stage-test",
        scopes=["sessions:read"] if failure == "auth" else ["sessions:write"],
    )
    row = Session(
        user_id=seed_user.id, local_session_id="stage-upload", started_at=datetime.now(UTC)
    )
    db_session.add(row)
    await db_session.commit()
    store = LocalFileStore(str(tmp_path))
    monkeypatch.setattr(sessions, "file_store", store)
    # Fault injection only: successful operations below remain the real
    # analyzer, filesystem, PostgreSQL index and transaction commit.
    targets = {
        "analysis": (sessions, "_analyze_session_upload"),
        "storage": (store, "put"),
        "index": (sessions, "replace_snapshot_search_index"),
        "commit": (db_session, "commit"),
    }
    if failure in targets:
        target, name = targets[failure]
        original = getattr(target, name)

        async def fail(*_args, **_kwargs):
            nonlocal elapsed
            # Authentication may commit last_used_at before handler entry.
            if failure == "commit" and row.file_key is None:
                return await original(*_args, **_kwargs)
            elapsed += 0.019
            raise RuntimeError("injected stage failure")

        monkeypatch.setattr(target, name, fail)

    captured = {}
    timed = request_timing.RequestTimingMiddleware(app, slow_ms=0.000001)

    async def capture(scope, receive, send):
        async def delayed_receive():
            nonlocal elapsed, body_elapsed
            message = await receive()
            if message["type"] == "http.request":
                elapsed += 0.017
                body_elapsed += 0.017
            return message

        try:
            await timed(scope, delayed_receive, send)
        finally:
            captured.update(scope["state"]["_request_stage_timings"])

    caplog.set_level(logging.WARNING, logger=request_timing.__name__)
    data = {"expected_content_hash": "0" * 64} if failure == "cas" else {}
    path = (
        "/v1/sessions/missing/upload" if failure == "lookup" else "/v1/sessions/stage-upload/upload"
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=capture), base_url="http://test"
    ) as client:

        async def upload():
            return await client.post(
                path,
                headers={"Authorization": f"Bearer {minted.raw_key}"},
                params={"unused": "query-secret"},
                data=data,
                files={
                    "file": (
                        "body-secret.json",
                        b'[{"role":"user","content":"body-secret"}]',
                        "application/json",
                    )
                },
            )

        if failure in targets:
            with pytest.raises(RuntimeError, match="injected stage failure"):
                await upload()
        else:
            response = await upload()
            assert response.status_code == {"lookup": 404, "cas": 409, "auth": 403}.get(
                failure, 200
            )
            if failure is None:
                assert (
                    await store.get(response.json()["file_key"])
                    == b'[{"role":"user","content":"body-secret"}]'
                )
                await db_session.refresh(row)
                assert row.content_hash == response.json()["content_hash"]
                assert row.search_index_revision is not None
                assert row.content_uploaded_at is not None

    stages = [
        "pre_handler_ms",
        "upload_lookup_lock_ms",
        "upload_spooled_read_ms",
        "upload_analysis_ms",
        "upload_storage_ms",
        "upload_index_ms",
        "upload_commit_ms",
    ]
    end = {"auth": 0, "lookup": 2, "analysis": 4, "cas": 4, "storage": 5, "index": 6}.get(
        failure, 7
    )
    assert set(captured) == set(stages[:end])
    if failure != "auth":
        # Real multipart parsing consumes simulated body arrival before the
        # dependency and handler; spooled reads must not count arrival twice.
        assert body_elapsed > 0
        assert captured["pre_handler_ms"] == pytest.approx((body_elapsed + 0.013) * 1000)
        if "upload_spooled_read_ms" in captured:
            assert captured["upload_spooled_read_ms"] == 0
    if failure in targets:
        assert captured[f"upload_{failure}_ms"] == pytest.approx(19)
    assert all(
        isinstance(value, float) and math.isfinite(value) and value >= 0
        for value in captured.values()
    )
    records = [r.getMessage() for r in caplog.records if r.name == request_timing.__name__]
    assert len(records) == 1
    for stage in captured:
        assert f"{stage}=" in records[0]
    for secret in (minted.raw_key, str(seed_user.id), "query-secret", "body-secret"):
        assert secret not in records[0]


@pytest.mark.parametrize(
    ("route", "failure"),
    [
        (route, failure)
        for route in ("", "/available", "/available/example")
        for failure in (None, "fetch")
    ]
    + [("", "invalidation"), ("", "response")],
)
async def test_connector_route_fetch_boundary(monkeypatch, caplog, route, failure):
    """Real routing/response validation, mocked auth and adapter boundary."""
    elapsed = 0.0
    monkeypatch.setattr(request_timing, "time", SimpleNamespace(perf_counter=lambda: elapsed))
    app = FastAPI()
    app.include_router(connectors.router, prefix="/v1")

    async def auth():
        nonlocal elapsed
        elapsed += 0.013
        return AuthContext(user=User(clerk_id="identity-secret"))

    app.dependency_overrides[require_user_auth_short_session] = auth
    monkeypatch.setattr(connectors.settings, "composio_api_key", "config-secret")

    async def fetch(*_args, **_kwargs):
        nonlocal elapsed
        elapsed += 0.023
        if failure == "fetch":
            raise ComposioProtocolError("injected adapter failure")
        if route == "":
            return [{}] if failure == "response" else []
        if route == "/available":
            return {"items": [], "total": 0, "page": 1, "page_size": 24}
        return ConnectorAvailableAppResponse(
            name="example", display_name="Example", logo="", description="", auth_type="none"
        )

    async def invalidate(_user):
        nonlocal elapsed
        elapsed += 0.037
        if failure == "invalidation":
            raise RuntimeError("injected invalidation failure")

    name = {
        "": "get_all_connected_accounts",
        "/available": "get_available_apps",
        "/available/example": "get_app_by_name",
    }[route]
    monkeypatch.setattr(connectors, name, fetch)
    monkeypatch.setattr(connectors, "invalidate_tool_router_mcp_session", invalidate)
    caplog.set_level(logging.WARNING, logger=request_timing.__name__)
    timed = request_timing.RequestTimingMiddleware(app, slow_ms=1)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=timed, raise_app_exceptions=False), base_url="http://test"
    ) as client:
        response = await client.get("/v1/connectors" + route, params={"search": "query-secret"})
    assert response.status_code == (502 if failure == "fetch" else 500 if failure else 200)
    records = [r.getMessage() for r in caplog.records if r.name == request_timing.__name__]
    assert len(records) == 1
    assert "pre_handler_ms=13.0" in records[0]
    assert "connector_route_fetch_ms=23.0" in records[0]
    assert ("connector_invalidation_ms=37.0" in records[0]) == (route == "" and failure != "fetch")
    assert ("connector_response_build_ms=0.0" in records[0]) == (
        route != "/available/example" and failure not in ("fetch", "invalidation")
    )
    assert all(
        secret not in records[0] for secret in ("identity-secret", "config-secret", "query-secret")
    )
