"""Verify the throwaway test database matches the production PostgreSQL contract."""

from __future__ import annotations

import asyncio
import os
from urllib.parse import urlparse

import asyncpg

EXPECTED_SERVER_VERSION_NUM = 180004
EXPECTED_VECTOR_VERSION = "0.8.6"
EXPECTED_DATA_DIRECTORY = "/var/lib/postgresql/18/docker"


async def check_runtime() -> None:
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url.startswith("postgresql+asyncpg://"):
        raise RuntimeError("DATABASE_URL must use postgresql+asyncpg")
    asyncpg_url = database_url.replace("+asyncpg", "", 1)
    parsed_url = urlparse(asyncpg_url)
    if parsed_url.hostname not in {"localhost", "127.0.0.1", "postgres"}:
        raise RuntimeError("runtime contract requires a local throwaway PostgreSQL host")
    if parsed_url.path != "/clawdi_test":
        raise RuntimeError("runtime contract requires the clawdi_test database")

    connection = await asyncpg.connect(asyncpg_url)
    try:
        server_version_num = int(await connection.fetchval("SHOW server_version_num"))
        if server_version_num != EXPECTED_SERVER_VERSION_NUM:
            raise RuntimeError(
                f"expected PostgreSQL 18.4 ({EXPECTED_SERVER_VERSION_NUM}), "
                f"got {server_version_num}"
            )

        data_directory = await connection.fetchval("SHOW data_directory")
        if data_directory != EXPECTED_DATA_DIRECTORY:
            raise RuntimeError(f"unexpected PostgreSQL data_directory: {data_directory}")

        await connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
        vector_version = await connection.fetchval(
            "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
        )
        if vector_version != EXPECTED_VECTOR_VERSION:
            raise RuntimeError(f"expected pgvector {EXPECTED_VECTOR_VERSION}, got {vector_version}")

        await connection.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        pg_trgm_version = await connection.fetchval(
            "SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'"
        )
        if not pg_trgm_version:
            raise RuntimeError("pg_trgm extension was not loadable")
    finally:
        await connection.close()

    print(
        "PostgreSQL runtime contract passed: "
        f"server_version_num={server_version_num}, vector={vector_version}, "
        f"pg_trgm={pg_trgm_version}, data_directory={data_directory}"
    )


if __name__ == "__main__":
    asyncio.run(check_runtime())
