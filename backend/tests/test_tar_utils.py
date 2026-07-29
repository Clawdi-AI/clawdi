from __future__ import annotations

import io
import tarfile
from base64 import b64decode
from pathlib import Path

import pytest

from app.routes.skills import _compute_file_tree_hash
from app.services import tar_utils


def _archive(files: tuple[tuple[str, bytes], ...]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, content in files:
            info = tarfile.TarInfo(name=name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def test_validate_tar_enforces_independent_regular_file_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tar_utils, "MAX_REGULAR_FILE_BYTES", 8)

    assert tar_utils.validate_tar(_archive((("demo/SKILL.md", b"12345678"),))) == 1
    with pytest.raises(tar_utils.TarValidationError, match="Regular file size exceeds"):
        tar_utils.validate_tar(_archive((("demo/SKILL.md", b"123456789"),)))


def test_validate_tar_preserves_total_expanded_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tar_utils, "MAX_REGULAR_FILE_BYTES", 8)
    monkeypatch.setattr(tar_utils, "MAX_DECOMPRESSED_BYTES", 10)

    with pytest.raises(tar_utils.TarValidationError, match="Decompressed size exceeds"):
        tar_utils.validate_tar(
            _archive(
                (
                    ("demo/SKILL.md", b"123456"),
                    ("demo/reference.md", b"abcdef"),
                )
            )
        )


def test_unicode_tree_hash_matches_typescript_archive_fixture() -> None:
    fixture = Path(__file__).parents[2] / "test-fixtures" / "skill-hash" / "unicode-tree.tar.gz.b64"
    archive = b64decode(fixture.read_text(encoding="ascii"))

    assert _compute_file_tree_hash(archive, "unicode") == (
        "18e78f6921e3d0fe6443fa12b74921e9b4bb5bead518ca9b3af638a2ab1eda10"
    )
