from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import random
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from app.core.config import settings
from app.models.channel import (
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_STATUS_ACTIVE,
    ChannelAccount,
)
from app.services.channels import decrypt_provider_token, record_discord_dispatch
from app.services.url_security import UnsafeOutboundUrlError, validate_channel_websocket_url

log = logging.getLogger(__name__)

DISCORD_GATEWAY_VERSION = "10"
DISCORD_GATEWAY_ENCODING = "json"
DISCORD_DEFAULT_INTENTS = 46593

_NON_RETRYABLE_CLOSE_CODES = {4004, 4010, 4011, 4012, 4013, 4014}


@dataclass
class _GatewayState:
    sequence: int | None = None
    heartbeat_acknowledged: bool = True


class DiscordGatewayWorker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        worker_id: str | None = None,
        lock_engine: AsyncEngine | None = None,
        scan_interval_seconds: float = 10.0,
        reconnect_initial_seconds: float = 1.0,
        reconnect_max_seconds: float = 60.0,
        connect_factory: Callable[..., Any] = connect,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._worker_id = worker_id or f"discord-gateway-{uuid.uuid4()}"
        self._lock_engine = lock_engine or _sessionmaker_bind(sessionmaker)
        self._scan_interval_seconds = scan_interval_seconds
        self._reconnect_initial_seconds = reconnect_initial_seconds
        self._reconnect_max_seconds = reconnect_max_seconds
        self._connect_factory = connect_factory
        self._tasks: dict[UUID, asyncio.Task[None]] = {}

    async def run_once(self, stop: asyncio.Event | None = None) -> int:
        account_ids = await list_active_discord_gateway_account_ids(self._sessionmaker)
        stop_event = stop or asyncio.Event()
        self._sync_tasks(account_ids, stop_event)
        return len(account_ids)

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop_event = stop or asyncio.Event()
        try:
            while not stop_event.is_set():
                await self.run_once(stop_event)
                try:
                    await asyncio.wait_for(
                        stop_event.wait(),
                        timeout=self._scan_interval_seconds,
                    )
                except TimeoutError:
                    pass
        finally:
            await self.stop()

    async def stop(self) -> None:
        for task in self._tasks.values():
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        self._tasks.clear()

    def _sync_tasks(self, active_account_ids: list[UUID], stop: asyncio.Event) -> None:
        active = set(active_account_ids)
        for account_id, task in list(self._tasks.items()):
            if task.done():
                self._observe_done_task(account_id, task)
                self._tasks.pop(account_id, None)
            elif account_id not in active:
                task.cancel()
        for account_id in active_account_ids:
            if account_id in self._tasks:
                continue
            self._tasks[account_id] = asyncio.create_task(
                self._run_account_forever(account_id, stop),
                name=f"discord-gateway-{account_id}",
            )

    async def _run_account_forever(self, account_id: UUID, stop: asyncio.Event) -> None:
        backoff_seconds = self._reconnect_initial_seconds
        while not stop.is_set():
            try:
                acquired = await self._run_account_with_lock(account_id, stop)
                if not acquired:
                    await _sleep_until_stop(stop, self._scan_interval_seconds)
                    return
                backoff_seconds = self._reconnect_initial_seconds
            except asyncio.CancelledError:
                raise
            except ConnectionClosed as exc:
                close_code = discord_gateway_close_code(exc)
                if close_code in _NON_RETRYABLE_CLOSE_CODES:
                    log.error(
                        "discord gateway account %s closed with non-retryable code %s",
                        account_id,
                        close_code,
                    )
                    await _sleep_until_stop(stop, self._reconnect_max_seconds)
                    continue
                log.warning("discord gateway account %s disconnected: %s", account_id, exc)
            except Exception as exc:  # noqa: BLE001 - gateway worker must reconnect after faults.
                log.exception("discord gateway account %s failed: %s", account_id, exc)
            await _sleep_until_stop(stop, backoff_seconds)
            backoff_seconds = min(backoff_seconds * 2, self._reconnect_max_seconds)

    async def _run_account_with_lock(self, account_id: UUID, stop: asyncio.Event) -> bool:
        lock_key = discord_gateway_advisory_lock_key(account_id)
        async with self._lock_engine.connect() as lock_connection:
            acquired = await _try_advisory_lock(lock_connection, lock_key)
            if not acquired:
                return False
            try:
                await self._connect_and_record(account_id, stop)
            finally:
                await _release_advisory_lock(lock_connection, lock_key)
        return True

    async def _connect_and_record(self, account_id: UUID, stop: asyncio.Event) -> None:
        account = await load_discord_gateway_account(self._sessionmaker, account_id)
        if account is None:
            return
        try:
            token = decrypt_provider_token(account)
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, str) else "provider token unavailable"
            raise RuntimeError(detail) from exc

        gateway_url = _account_gateway_url(account)
        try:
            await validate_channel_websocket_url(gateway_url, label="discord gateway url")
        except UnsafeOutboundUrlError as exc:
            raise RuntimeError(str(exc)) from exc
        uri = discord_gateway_uri(gateway_url)
        state = _GatewayState()
        async with self._connect_factory(
            uri,
            ping_interval=None,
            max_size=2**22,
            open_timeout=30,
        ) as websocket:
            hello = await _recv_gateway_frame(websocket)
            heartbeat_interval = _heartbeat_interval_seconds(hello)
            heartbeat_task = asyncio.create_task(
                _heartbeat_loop(websocket, state, heartbeat_interval, stop),
                name=f"discord-gateway-heartbeat-{account_id}",
            )
            try:
                await websocket.send(
                    _gateway_json(
                        discord_identify_payload(
                            token=token,
                            intents=discord_gateway_intents(account),
                        )
                    )
                )
                while not stop.is_set():
                    try:
                        frame = await asyncio.wait_for(websocket.recv(), timeout=1.0)
                    except TimeoutError:
                        continue
                    await self._handle_gateway_frame(account_id, frame, state, websocket)
            finally:
                heartbeat_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await heartbeat_task

    async def _handle_gateway_frame(
        self,
        account_id: UUID,
        raw_frame: str | bytes,
        state: _GatewayState,
        websocket: Any,
    ) -> None:
        frame = parse_gateway_frame(raw_frame)
        if frame is None:
            return
        sequence = frame.get("s")
        if isinstance(sequence, int):
            state.sequence = sequence
        op = frame.get("op")
        if op == 0:
            await record_discord_gateway_dispatch(self._sessionmaker, account_id, frame)
        elif op == 1:
            await _send_heartbeat(websocket, state)
        elif op == 7:
            raise RuntimeError("discord requested reconnect")
        elif op == 9:
            raise RuntimeError("discord invalidated gateway session")
        elif op == 11:
            state.heartbeat_acknowledged = True

    def _observe_done_task(self, account_id: UUID, task: asyncio.Task[None]) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            exc = task.exception()
            if exc is not None:
                log.error("discord gateway task %s exited: %s", account_id, exc)


async def list_active_discord_gateway_account_ids(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> list[UUID]:
    async with sessionmaker() as db:
        result = await db.execute(
            select(ChannelAccount)
            .where(
                ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
                ChannelAccount.encrypted_provider_token.is_not(None),
                ChannelAccount.provider_token_nonce.is_not(None),
            )
            .order_by(ChannelAccount.created_at, ChannelAccount.id)
        )
        accounts = result.scalars().all()
        return [account.id for account in accounts if discord_gateway_enabled(account)]


async def load_discord_gateway_account(
    sessionmaker: async_sessionmaker[AsyncSession],
    account_id: UUID,
) -> ChannelAccount | None:
    async with sessionmaker() as db:
        result = await db.execute(
            select(ChannelAccount).where(
                ChannelAccount.id == account_id,
                ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
                ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
                ChannelAccount.archived_at.is_(None),
            )
        )
        account = result.scalar_one_or_none()
        if account is None or not discord_gateway_enabled(account):
            return None
        return account


async def record_discord_gateway_dispatch(
    sessionmaker: async_sessionmaker[AsyncSession],
    account_id: UUID,
    frame: dict[str, Any],
) -> bool:
    async with sessionmaker() as db:
        account = await _load_active_discord_account(db, account_id)
        if account is None:
            await db.rollback()
            return False
        recorded = await record_discord_dispatch(db, account=account, frame=frame)
        if recorded:
            await db.commit()
            return True
        await db.rollback()
        return False


async def _load_active_discord_account(
    db: AsyncSession,
    account_id: UUID,
) -> ChannelAccount | None:
    result = await db.execute(
        select(ChannelAccount).where(
            ChannelAccount.id == account_id,
            ChannelAccount.provider == CHANNEL_PROVIDER_DISCORD,
            ChannelAccount.status == CHANNEL_STATUS_ACTIVE,
            ChannelAccount.archived_at.is_(None),
        )
    )
    return result.scalar_one_or_none()


def discord_gateway_uri(base_url: str) -> str:
    parts = urlsplit(base_url.strip())
    params = dict(parse_qsl(parts.query, keep_blank_values=True))
    params["v"] = DISCORD_GATEWAY_VERSION
    params["encoding"] = DISCORD_GATEWAY_ENCODING
    return urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path or "/",
            urlencode(params),
            parts.fragment,
        )
    )


def discord_identify_payload(*, token: str, intents: int) -> dict[str, Any]:
    return {
        "op": 2,
        "d": {
            "token": token,
            "intents": intents,
            "properties": {
                "os": "linux",
                "browser": "clawdi",
                "device": "clawdi",
            },
        },
    }


def discord_gateway_intents(account: ChannelAccount) -> int:
    value = _account_config_value(account, "gateway_intents")
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return DISCORD_DEFAULT_INTENTS


def discord_gateway_enabled(account: ChannelAccount) -> bool:
    value = _account_config_value(account, "gateway_enabled")
    return value is not False


def parse_gateway_frame(raw_frame: str | bytes) -> dict[str, Any] | None:
    if isinstance(raw_frame, bytes):
        raw_frame = raw_frame.decode("utf-8")
    payload = json.loads(raw_frame)
    return payload if isinstance(payload, dict) else None


def discord_gateway_advisory_lock_key(account_id: UUID) -> int:
    digest = hashlib.blake2b(
        f"discord-gateway:{account_id}".encode(),
        digest_size=8,
    ).digest()
    return int.from_bytes(digest, byteorder="big", signed=False) & 0x7FFF_FFFF_FFFF_FFFF


def discord_gateway_close_code(exc: ConnectionClosed) -> int | None:
    value = getattr(exc, "code", None)
    return value if isinstance(value, int) else None


async def _try_advisory_lock(connection: Any, lock_key: int) -> bool:
    result = await connection.execute(
        text("SELECT pg_try_advisory_lock(:lock_key)"),
        {"lock_key": lock_key},
    )
    await connection.commit()
    return result.scalar_one() is True


async def _release_advisory_lock(connection: Any, lock_key: int) -> None:
    await connection.execute(
        text("SELECT pg_advisory_unlock(:lock_key)"),
        {"lock_key": lock_key},
    )
    await connection.commit()


async def _recv_gateway_frame(websocket: Any) -> dict[str, Any]:
    frame = parse_gateway_frame(await websocket.recv())
    if frame is None:
        raise RuntimeError("discord gateway sent a non-object frame")
    return frame


def _heartbeat_interval_seconds(hello: dict[str, Any]) -> float:
    if hello.get("op") != 10:
        raise RuntimeError("discord gateway did not send hello")
    data = hello.get("d")
    if not isinstance(data, dict):
        raise RuntimeError("discord gateway hello is missing data")
    interval = data.get("heartbeat_interval")
    if not isinstance(interval, int | float) or interval <= 0:
        raise RuntimeError("discord gateway hello has invalid heartbeat interval")
    return float(interval) / 1000


async def _heartbeat_loop(
    websocket: Any,
    state: _GatewayState,
    interval_seconds: float,
    stop: asyncio.Event,
) -> None:
    await _sleep_until_stop(stop, interval_seconds * random.random())
    while not stop.is_set():
        if not state.heartbeat_acknowledged:
            await websocket.close(code=4000, reason="heartbeat ack timeout")
            return
        await _send_heartbeat(websocket, state)
        await _sleep_until_stop(stop, interval_seconds)


async def _send_heartbeat(websocket: Any, state: _GatewayState) -> None:
    state.heartbeat_acknowledged = False
    await websocket.send(_gateway_json({"op": 1, "d": state.sequence}))


async def _sleep_until_stop(stop: asyncio.Event, timeout_seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=timeout_seconds)
    except TimeoutError:
        pass


def _gateway_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _account_gateway_url(account: ChannelAccount) -> str:
    value = _account_config_value(account, "gateway_url")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return settings.channel_discord_gateway_url.strip()


def _account_config_value(account: ChannelAccount, key: str) -> Any:
    if not isinstance(account.config, dict):
        return None
    return account.config.get(key)


def _sessionmaker_bind(sessionmaker: async_sessionmaker[AsyncSession]) -> AsyncEngine:
    bind = sessionmaker.kw.get("bind")
    if not isinstance(bind, AsyncEngine):
        raise TypeError(
            "DiscordGatewayWorker requires an async_sessionmaker bound to an AsyncEngine"
        )
    return bind
