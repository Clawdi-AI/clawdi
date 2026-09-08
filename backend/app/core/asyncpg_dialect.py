"""Keep SQLAlchemy pool invalidation atomic under AnyIO level cancellation."""

import asyncio
from typing import cast

import anyio
from sqlalchemy.dialects.postgresql.asyncpg import PGDialect_asyncpg
from sqlalchemy.engine.interfaces import DBAPIConnection, Dialect


class CancellationSafeAsyncpgDialect(PGDialect_asyncpg):
    supports_statement_cache = True

    def do_terminate(self, dbapi_connection: DBAPIConnection) -> None:
        parent = cast(Dialect, super())
        # Pre-ping can fail before a session/connection takes ownership. A
        # second cancellation during termination would skip the pool checkin.
        try:
            task = asyncio.current_task()
        except RuntimeError:
            task = None
        if task is None:
            # GC can also terminate connections outside a running task/loop.
            parent.do_terminate(dbapi_connection)
            return
        with anyio.CancelScope(shield=True):
            parent.do_terminate(dbapi_connection)
