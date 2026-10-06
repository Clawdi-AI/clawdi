"""Load Alembic migration modules without importing the versions directory."""

import importlib.util
from pathlib import Path
from types import ModuleType


def load_migration(filename: str, module_name: str) -> ModuleType:
    migration_path = Path(__file__).parents[1] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(module_name, migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration
