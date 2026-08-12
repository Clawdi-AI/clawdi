from __future__ import annotations

import tomllib
import zoneinfo
from importlib.metadata import version
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def test_production_dependencies_resolve_iana_timezone_without_system_database(
    tmp_path: Path,
) -> None:
    project = tomllib.loads((BACKEND_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert f"tzdata=={version('tzdata')}" in project["project"]["dependencies"]

    original_tzpath = zoneinfo.TZPATH
    try:
        zoneinfo.reset_tzpath([tmp_path])
        zoneinfo.ZoneInfo.clear_cache()
        assert zoneinfo.ZoneInfo("Asia/Calcutta").key == "Asia/Calcutta"
    finally:
        zoneinfo.reset_tzpath(original_tzpath)
        zoneinfo.ZoneInfo.clear_cache()
