"""Run one bounded snapshot sweep, optionally without deleting objects."""

import argparse
import asyncio

from app.core.database import async_session_factory, engine
from app.services.session_snapshot_retention_worker import SessionSnapshotRetentionWorker


async def _run(*, dry_run: bool) -> None:
    try:
        async with asyncio.timeout(60):
            count = await SessionSnapshotRetentionWorker(async_session_factory).run_once(
                dry_run=dry_run
            )
        print(f"snapshot_sweep candidates={count} dry_run={dry_run}")
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    asyncio.run(_run(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
