"""Typed lifecycle wrapper for asyncpg's untyped listener connection."""

from __future__ import annotations

from collections.abc import Callable, Mapping

import asyncpg

type NotificationCallback = Callable[[int, str, str], None]
type _AsyncpgNotificationCallback = Callable[
    [object, int, str, object],
    None,
]


class PostgresListenerError(RuntimeError):
    """Sanitized asyncpg connection or listener failure."""


class PostgresListener:
    def __init__(
        self,
        connection: asyncpg.Connection,
        listeners: Mapping[str, _AsyncpgNotificationCallback],
    ) -> None:
        self._connection = connection
        self._listeners = dict(listeners)

    def is_closed(self) -> bool:
        return self._connection.is_closed()

    async def close(self) -> None:
        try:
            try:
                for channel, callback in self._listeners.items():
                    await self._connection.remove_listener(channel, callback)
            finally:
                await self._connection.close(timeout=5)
        except (asyncpg.PostgresError, OSError, TimeoutError) as exc:
            raise PostgresListenerError("PostgreSQL listener close failed") from exc


async def connect_postgres_listener(
    dsn: str,
    channels: Mapping[str, NotificationCallback],
    terminated: Callable[[], None],
) -> PostgresListener:
    try:
        connection = await asyncpg.connect(dsn, timeout=10)
    except (asyncpg.PostgresError, OSError, TimeoutError) as exc:
        raise PostgresListenerError("PostgreSQL listener connection failed") from exc

    def on_termination(_connection: object) -> None:
        terminated()

    listeners: dict[str, _AsyncpgNotificationCallback] = {}
    try:
        for channel, notification in channels.items():

            def on_notification(
                _connection: object,
                pid: int,
                received_channel: str,
                payload: object,
                *,
                callback: NotificationCallback = notification,
            ) -> None:
                if not isinstance(payload, str):
                    raise PostgresListenerError("PostgreSQL notification payload is invalid")
                callback(pid, received_channel, payload)

            listeners[channel] = on_notification
            await connection.add_listener(channel, on_notification)
        connection.add_termination_listener(on_termination)
    except (asyncpg.PostgresError, OSError, TimeoutError) as exc:
        try:
            await connection.close(timeout=5)
        except (asyncpg.PostgresError, OSError, TimeoutError):
            pass
        raise PostgresListenerError("PostgreSQL listener registration failed") from exc
    return PostgresListener(connection, listeners)
