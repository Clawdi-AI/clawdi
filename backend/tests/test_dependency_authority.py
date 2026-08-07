from pathlib import Path

import pytest

from scripts import check_dependency_authority


def test_dependency_authority_accepts_uv_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "uv.lock").touch()
    monkeypatch.setattr(check_dependency_authority, "BACKEND_ROOT", tmp_path)

    assert check_dependency_authority.main() == 0


def test_dependency_authority_rejects_second_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "uv.lock").touch()
    (tmp_path / "pdm.lock").touch()
    monkeypatch.setattr(check_dependency_authority, "BACKEND_ROOT", tmp_path)

    with pytest.raises(SystemExit, match="non-uv lock authority"):
        check_dependency_authority.main()
