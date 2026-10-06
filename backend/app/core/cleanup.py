import asyncio
import logging
from collections.abc import Callable, Coroutine

import anyio

log = logging.getLogger(__name__)


async def finish_cleanup(cleanup: Callable[[], Coroutine[object, object, None]]) -> None:
    """Finish owned cleanup before propagating request cancellation."""
    cleanup_task = asyncio.create_task(cleanup())
    cancellation: asyncio.CancelledError | None = None

    with anyio.CancelScope(shield=True):
        while not cleanup_task.done():
            try:
                await asyncio.shield(cleanup_task)
            except asyncio.CancelledError as exc:
                cancellation = exc
            except Exception as exc:
                if cancellation is None:
                    raise

                log.exception("Cleanup failed during request cancellation")
                raise cancellation from exc

    try:
        cleanup_task.result()
    except Exception as exc:
        if cancellation is None:
            raise

        log.exception("Cleanup failed during request cancellation")
        raise cancellation from exc

    if cancellation is not None:
        raise cancellation
