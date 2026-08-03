"""Typed lifecycle wrapper for asyncpg's untyped listener connection."""

from __future__ import annotations

from collections.abc import Callable

import asyncpg

type NotificationCallback = Callable[[int, str, str], None]


class PostgresListener:
    def __init__(self, connection, channel: str, callback) -> None:
        self._connection = connection
        self._channel = channel
        self._callback = callback

    def is_closed(self) -> bool:
        return self._connection.is_closed()

    async def close(self) -> None:
        try:
            await self._connection.remove_listener(self._channel, self._callback)
        finally:
            await self._connection.close(timeout=5)


async def connect_postgres_listener(
    dsn: str,
    channel: str,
    notification: NotificationCallback,
    terminated: Callable[[], None],
) -> PostgresListener:
    connection = await asyncpg.connect(dsn, timeout=10)

    def on_notification(_connection, pid: int, received_channel: str, payload: str) -> None:
        notification(pid, received_channel, payload)

    await connection.add_listener(channel, on_notification)
    connection.add_termination_listener(lambda _connection: terminated())
    return PostgresListener(connection, channel, on_notification)
