from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import random
from dataclasses import dataclass
from types import TracebackType
from typing import Protocol
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID

from fastapi import HTTPException
from pydantic import JsonValue, TypeAdapter
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession, async_sessionmaker
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from app.core.config import settings
from app.models.channel import (
    BINDING_STATUS_ACTIVE,
    CHANNEL_PROVIDER_DISCORD,
    CHANNEL_STATUS_ACTIVE,
    ChannelAccount,
    ChannelBinding,
)
from app.services.channels import (
    decrypt_provider_token,
    record_discord_dispatch,
    update_discord_binding_display_name_from_trusted_event,
)
from app.services.discord_command_reconciliation_worker import (
    reconcile_discord_guild_commands,
    reconcile_discord_guild_departure,
)
from app.services.url_security import UnsafeOutboundUrlError, validate_channel_websocket_url

log = logging.getLogger(__name__)

DISCORD_GATEWAY_VERSION = "10"
DISCORD_GATEWAY_ENCODING = "json"
DISCORD_DEFAULT_INTENTS = 46593

_NON_RETRYABLE_CLOSE_CODES = {4004, 4010, 4011, 4012, 4013, 4014}
_SESSION_RESET_CLOSE_CODES = {4007, 4009}

type GatewayFrame = dict[str, JsonValue]

_GATEWAY_JSON_ADAPTER: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)


class _GatewayReconnect(RuntimeError):
    """Discord requested an immediate reconnect so the session can resume."""


class _GatewayConnection(Protocol):
    """The WebSocket operations required by one Discord Gateway session."""

    async def recv(self) -> str | bytes: ...

    async def send(self, message: str, /) -> None: ...

    async def close(self, *, code: int, reason: str) -> None: ...


class _GatewayConnectionContext(Protocol):
    async def __aenter__(self) -> _GatewayConnection: ...

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
        /,
    ) -> None: ...


class _GatewayConnectFactory(Protocol):
    def __call__(
        self,
        uri: str,
        *,
        ping_interval: float | None,
        max_size: int | None,
        open_timeout: float | None,
    ) -> _GatewayConnectionContext: ...


@dataclass
class _GatewayState:
    sequence: int | None = None
    heartbeat_acknowledged: bool = True
    session_id: str | None = None
    resume_gateway_url: str | None = None
    account_revision: str | None = None
    # Preserve this marker when INVALID_SESSION clears the resume fields so
    # the outer loop still resets backoff after an established connection.
    session_established: bool = False

    def can_resume(self) -> bool:
        return self.sequence is not None and bool(self.session_id) and bool(self.resume_gateway_url)

    def clear_session(self) -> None:
        self.sequence = None
        self.session_id = None
        self.resume_gateway_url = None
        self.heartbeat_acknowledged = True


class DiscordGatewayWorker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        *,
        lock_engine: AsyncEngine | None = None,
        scan_interval_seconds: float = 10.0,
        reconnect_initial_seconds: float = 1.0,
        reconnect_max_seconds: float = 60.0,
        connect_factory: _GatewayConnectFactory = connect,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._lock_engine = lock_engine or _sessionmaker_bind(sessionmaker)
        self._scan_interval_seconds = scan_interval_seconds
        self._reconnect_initial_seconds = reconnect_initial_seconds
        self._reconnect_max_seconds = reconnect_max_seconds
        self._connect_factory = connect_factory
        self._tasks: dict[UUID, asyncio.Task[None]] = {}
        self._terminal_account_revisions: dict[UUID, str] = {}

    async def run_once(self, stop: asyncio.Event | None = None) -> int:
        accounts = await list_active_discord_gateway_accounts(self._sessionmaker)
        stop_event = stop or asyncio.Event()
        self._sync_tasks(accounts, stop_event)
        return len(accounts)

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
        self._terminal_account_revisions.clear()

    def _sync_tasks(
        self,
        active_accounts: dict[UUID, str],
        stop: asyncio.Event,
    ) -> None:
        active = set(active_accounts)
        for account_id, task in list(self._tasks.items()):
            if task.done():
                self._observe_done_task(account_id, task)
                self._tasks.pop(account_id, None)
            elif account_id not in active:
                task.cancel()
        for account_id in set(self._terminal_account_revisions) - active:
            self._terminal_account_revisions.pop(account_id, None)
        for account_id, revision in active_accounts.items():
            if account_id in self._tasks:
                continue
            terminal_revision = self._terminal_account_revisions.get(account_id)
            if terminal_revision == revision:
                continue
            if terminal_revision is not None:
                self._terminal_account_revisions.pop(account_id, None)
            self._tasks[account_id] = asyncio.create_task(
                self._run_account_forever(account_id, stop),
                name=f"discord-gateway-{account_id}",
            )

    async def _run_account_forever(self, account_id: UUID, stop: asyncio.Event) -> None:
        backoff_seconds = self._reconnect_initial_seconds
        state = _GatewayState()
        while not stop.is_set():
            try:
                acquired = await self._run_account_with_lock(account_id, stop, state)
                if not acquired:
                    await _sleep_until_stop(stop, self._scan_interval_seconds)
                    return
                backoff_seconds = self._reconnect_initial_seconds
            except asyncio.CancelledError:
                raise
            except _GatewayReconnect:
                state.session_established = False
                backoff_seconds = self._reconnect_initial_seconds
                continue
            except ConnectionClosed as exc:
                close_code = discord_gateway_close_code(exc)
                if close_code in _SESSION_RESET_CLOSE_CODES:
                    state.clear_session()
                if close_code in _NON_RETRYABLE_CLOSE_CODES:
                    log.error(
                        "discord gateway account %s closed with non-retryable code %s",
                        account_id,
                        close_code,
                    )
                    if state.account_revision is not None:
                        self._terminal_account_revisions[account_id] = state.account_revision
                    return
                log.warning("discord gateway account %s disconnected: %s", account_id, exc)
            except Exception as exc:
                # Gateway workers must reconnect after transport and protocol faults.
                log.exception("discord gateway account %s failed: %s", account_id, exc)
            if state.session_established:
                state.session_established = False
                backoff_seconds = self._reconnect_initial_seconds
            await _sleep_until_stop(stop, backoff_seconds)
            backoff_seconds = min(backoff_seconds * 2, self._reconnect_max_seconds)

    async def _run_account_with_lock(
        self,
        account_id: UUID,
        stop: asyncio.Event,
        state: _GatewayState,
    ) -> bool:
        lock_key = discord_gateway_advisory_lock_key(account_id)
        async with self._lock_engine.connect() as lock_connection:
            acquired = await try_advisory_lock(lock_connection, lock_key)
            if not acquired:
                return False
            try:
                await self._connect_and_record(account_id, stop, state)
            finally:
                if not await release_advisory_lock(lock_connection, lock_key):
                    raise RuntimeError("discord gateway advisory unlock failed")
        return True

    async def _connect_and_record(
        self,
        account_id: UUID,
        stop: asyncio.Event,
        state: _GatewayState,
    ) -> None:
        account = await load_discord_gateway_account(self._sessionmaker, account_id)
        if account is None:
            return
        state.account_revision = discord_gateway_account_revision(account)
        try:
            token = decrypt_provider_token(account)
        except HTTPException as exc:
            raise RuntimeError(_provider_token_error_detail(exc.detail)) from exc

        can_resume = state.can_resume()
        gateway_url = state.resume_gateway_url
        if not can_resume or gateway_url is None:
            gateway_url = _account_gateway_url(account)
        try:
            await validate_channel_websocket_url(gateway_url, label="discord gateway url")
        except UnsafeOutboundUrlError as exc:
            raise RuntimeError(str(exc)) from exc
        uri = discord_gateway_uri(gateway_url)
        await self._run_gateway_session(
            account_id=account_id,
            stop=stop,
            state=state,
            uri=uri,
            token=token,
            intents=discord_gateway_intents(account),
            resume=can_resume,
        )

    async def _run_gateway_session(
        self,
        *,
        account_id: UUID,
        stop: asyncio.Event,
        state: _GatewayState,
        uri: str,
        token: str,
        intents: int,
        resume: bool,
    ) -> None:
        state.heartbeat_acknowledged = True
        state.session_established = False
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
                if resume and state.session_id is not None and state.sequence is not None:
                    await websocket.send(
                        _gateway_json(
                            discord_resume_payload(
                                token=token,
                                session_id=state.session_id,
                                sequence=state.sequence,
                            )
                        )
                    )
                else:
                    state.clear_session()
                    await websocket.send(
                        _gateway_json(
                            discord_identify_payload(
                                token=token,
                                intents=intents,
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
        websocket: _GatewayConnection,
    ) -> None:
        frame = parse_gateway_frame(raw_frame)
        if frame is None:
            return
        sequence = frame.get("s")
        op = frame.get("op")
        if op == 0:
            _update_gateway_session_state(state, frame)
            if frame.get("t") in {"READY", "RESUMED"}:
                state.session_established = True
            await record_discord_gateway_dispatch(
                self._sessionmaker,
                account_id,
                frame,
                gateway_session_id=state.session_id,
            )
            # A RESUME sequence acknowledges every Dispatch through this value.
            # Advance it only after the event's durable admission succeeds, or
            # a reconnect could skip the failed event permanently.
            if isinstance(sequence, int) and not isinstance(sequence, bool):
                state.sequence = sequence
        elif op == 1:
            await _send_heartbeat(websocket, state)
        elif op == 7:
            raise _GatewayReconnect
        elif op == 9:
            if frame.get("d") is not True:
                state.clear_session()
            raise RuntimeError("discord invalidated gateway session")
        elif op == 11:
            state.heartbeat_acknowledged = True

    def _observe_done_task(self, account_id: UUID, task: asyncio.Task[None]) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            exc = task.exception()
            if exc is not None:
                log.error("discord gateway task %s exited: %s", account_id, exc)


async def list_active_discord_gateway_accounts(
    sessionmaker: async_sessionmaker[AsyncSession],
) -> dict[UUID, str]:
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
        return {
            account.id: discord_gateway_account_revision(account)
            for account in accounts
            if discord_gateway_enabled(account)
        }


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
    frame: GatewayFrame,
    *,
    gateway_session_id: str | None = None,
) -> bool:
    async with sessionmaker() as db:
        account = await _load_active_discord_account(db, account_id)
        if account is None:
            await db.rollback()
            return False
        if frame.get("t") == "GUILD_DELETE":
            await db.rollback()
            guild_id = _discord_departed_guild_id(frame)
            if guild_id is None:
                # unavailable=true is a temporary outage, not a departure.
                return True
            # Do not acknowledge an authority-loss event until its binding
            # mutation is durable. A database failure must reconnect/resume so
            # Discord can replay the sequence; provider cleanup itself is
            # persisted as retry state and does not raise for normal failures.
            await reconcile_discord_guild_departure(
                sessionmaker,
                account_id=account_id,
                guild_id=guild_id,
                lifecycle_event_id=_discord_lifecycle_event_id(
                    frame,
                    gateway_session_id=gateway_session_id,
                    guild_id=guild_id,
                ),
            )
            return True
        display_name_healed = await _heal_discord_guild_binding_display_name(
            db,
            account=account,
            frame=frame,
        )
        recorded = await record_discord_dispatch(db, account=account, frame=frame)
        if recorded or display_name_healed:
            await db.commit()
        else:
            await db.rollback()
        guild_id = _discord_available_guild_id(frame)
        if guild_id is not None:
            try:
                await reconcile_discord_guild_commands(
                    sessionmaker,
                    account_id=account_id,
                    guild_id=guild_id,
                )
            # Reconciliation failures must not reconnect the healthy Gateway.
            except Exception:
                log.exception(
                    "discord_command_guild_create_reconciliation_failed account_id=%s guild_id=%s",
                    account_id,
                    guild_id,
                )
        return recorded


async def _heal_discord_guild_binding_display_name(
    db: AsyncSession,
    *,
    account: ChannelAccount,
    frame: GatewayFrame,
) -> bool:
    """Backfill a bound guild name from one bot-authenticated Gateway event."""
    guild_id = _discord_available_guild_id(frame)
    if guild_id is None:
        return False
    data = frame.get("d")
    guild_name = data.get("name") if isinstance(data, dict) else None
    result = await db.execute(
        select(ChannelBinding).where(
            ChannelBinding.account_id == account.id,
            ChannelBinding.external_chat_id == guild_id,
            ChannelBinding.status == BINDING_STATUS_ACTIVE,
        )
    )
    changed = False
    for binding in result.scalars().all():
        if update_discord_binding_display_name_from_trusted_event(
            binding,
            external_chat_id=guild_id,
            external_chat_type="guild",
            external_chat_name=guild_name if isinstance(guild_name, str) else None,
            external_user_id=None,
        ):
            changed = True
    return changed


def _discord_available_guild_id(frame: GatewayFrame) -> str | None:
    if frame.get("t") != "GUILD_CREATE":
        return None
    data = frame.get("d")
    if not isinstance(data, dict) or data.get("unavailable") is True:
        return None
    guild_id = data.get("id")
    return guild_id if isinstance(guild_id, str) and guild_id else None


def _discord_departed_guild_id(frame: GatewayFrame) -> str | None:
    data = frame.get("d")
    if not isinstance(data, dict) or data.get("unavailable") is True:
        return None
    guild_id = data.get("id")
    return guild_id if isinstance(guild_id, str) and guild_id else None


def _discord_lifecycle_event_id(
    frame: GatewayFrame,
    *,
    gateway_session_id: str | None,
    guild_id: str,
) -> str:
    sequence = frame.get("s")
    sequence_key = (
        str(sequence)
        if isinstance(sequence, int) and not isinstance(sequence, bool)
        else hashlib.sha256(
            json.dumps(frame, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
    )
    return f"{gateway_session_id or 'unknown'}:{sequence_key}:GUILD_DELETE:{guild_id}"


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


def discord_identify_payload(*, token: str, intents: int) -> GatewayFrame:
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


def discord_resume_payload(
    *,
    token: str,
    session_id: str,
    sequence: int,
) -> GatewayFrame:
    return {
        "op": 6,
        "d": {
            "token": token,
            "session_id": session_id,
            "seq": sequence,
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


def discord_gateway_account_revision(account: ChannelAccount) -> str:
    """Fingerprint the credentials and configuration that drive one Gateway session."""

    config = account.config if isinstance(account.config, dict) else {}
    material = b"\0".join(
        (
            account.encrypted_provider_token or b"",
            account.provider_token_nonce or b"",
            json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        )
    )
    return hashlib.sha256(material).hexdigest()


def parse_gateway_frame(raw_frame: str | bytes) -> GatewayFrame | None:
    payload = _GATEWAY_JSON_ADAPTER.validate_json(raw_frame)
    return payload if isinstance(payload, dict) else None


def _provider_token_error_detail(detail: object) -> str:
    return detail if isinstance(detail, str) else "provider token unavailable"


def _update_gateway_session_state(state: _GatewayState, frame: GatewayFrame) -> None:
    if frame.get("t") != "READY":
        return
    data = frame.get("d")
    if not isinstance(data, dict):
        return
    session_id = data.get("session_id")
    resume_gateway_url = data.get("resume_gateway_url")
    if isinstance(session_id, str) and session_id.strip():
        state.session_id = session_id
    if isinstance(resume_gateway_url, str) and resume_gateway_url.strip():
        state.resume_gateway_url = resume_gateway_url


def discord_gateway_advisory_lock_key(account_id: UUID) -> int:
    digest = hashlib.blake2b(
        f"discord-gateway:{account_id}".encode(),
        digest_size=8,
    ).digest()
    return int.from_bytes(digest, byteorder="big", signed=False) & 0x7FFF_FFFF_FFFF_FFFF


def discord_gateway_close_code(exc: ConnectionClosed) -> int | None:
    return exc.rcvd.code if exc.rcvd is not None else None


async def try_advisory_lock(connection: AsyncConnection, lock_key: int) -> bool:
    result = await connection.execute(
        text("SELECT pg_try_advisory_lock(:lock_key)"),
        {"lock_key": lock_key},
    )
    await connection.commit()
    return result.scalar_one() is True


async def release_advisory_lock(connection: AsyncConnection, lock_key: int) -> bool:
    result = await connection.execute(
        text("SELECT pg_advisory_unlock(:lock_key)"),
        {"lock_key": lock_key},
    )
    await connection.commit()
    return result.scalar_one() is True


async def _recv_gateway_frame(websocket: _GatewayConnection) -> GatewayFrame:
    frame = parse_gateway_frame(await websocket.recv())
    if frame is None:
        raise RuntimeError("discord gateway sent a non-object frame")
    return frame


def _heartbeat_interval_seconds(hello: GatewayFrame) -> float:
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
    websocket: _GatewayConnection,
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


async def _send_heartbeat(websocket: _GatewayConnection, state: _GatewayState) -> None:
    state.heartbeat_acknowledged = False
    await websocket.send(_gateway_json({"op": 1, "d": state.sequence}))


async def _sleep_until_stop(stop: asyncio.Event, timeout_seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=timeout_seconds)
    except TimeoutError:
        pass


def _gateway_json(payload: GatewayFrame) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _account_gateway_url(account: ChannelAccount) -> str:
    value = _account_config_value(account, "gateway_url")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return settings.channel_discord_gateway_url.strip()


def _account_config_value(account: ChannelAccount, key: str) -> object:
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
