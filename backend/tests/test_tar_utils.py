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


def test_reroot_skill_archive_preserves_the_file_tree() -> None:
    source_key = "devops/phala-cloud-admin-ops"
    local_key = "phala-cloud-admin-ops"
    source = _archive(
        (
            (f"{source_key}/SKILL.md", b"---\nname: phala-cloud-admin-ops\n---\n"),
            (f"{source_key}/references/runbook.md", b"runbook\n"),
        )
    )

    rerooted = tar_utils.reroot_skill_archive(source, source_key, local_key)

    with tarfile.open(fileobj=io.BytesIO(rerooted), mode="r:gz") as archive:
        assert sorted(archive.getnames()) == [
            f"{local_key}/SKILL.md",
            f"{local_key}/references/runbook.md",
        ]
    assert _compute_file_tree_hash(source, source_key) == _compute_file_tree_hash(
        rerooted, local_key
    )


def test_unicode_tree_hash_matches_typescript_archive_fixture() -> None:
    fixture = Path(__file__).parents[2] / "test-fixtures" / "skill-hash" / "unicode-tree.tar.gz.b64"
    archive = b64decode(fixture.read_text(encoding="ascii"))

    assert _compute_file_tree_hash(archive, "unicode") == (
        "18e78f6921e3d0fe6443fa12b74921e9b4bb5bead518ca9b3af638a2ab1eda10"
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("name", ""),
        ("name", "Uppercase"),
        ("name", "a--b"),
        ("name", "a" * 65),
        ("name", " name"),
        ("name", 123),
        ("description", ""),
        ("description", " \t "),
        ("description", "a" * 1025),
        ("description", False),
        ("license", None),
        ("license", ["MIT"]),
        ("compatibility", ""),
        ("compatibility", " \t "),
        ("compatibility", "a" * 501),
        ("compatibility", {"runtime": "hermes"}),
        ("metadata", None),
        ("metadata", {"version": 1.0}),
        ("metadata", {1: "value"}),
        ("metadata", []),
        ("allowed-tools", None),
        ("allowed-tools", ["Read"]),
    ],
)
def test_strict_frontmatter_rejects_invalid_known_fields(field, value) -> None:
    import yaml

    metadata = {"name": "example", "description": "Valid description", field: value}
    document = f"---\n{yaml.safe_dump(metadata)}---\nInstructions.\n"
    with pytest.raises(tar_utils.SkillTextValidationError):
        tar_utils.validate_skill_frontmatter(document)


@pytest.mark.parametrize("ending", ["---", "---\r\n", "---\n"])
def test_strict_frontmatter_preserves_boundaries_unicode_and_extensions(ending: str) -> None:
    import yaml

    metadata = {
        "name": "café",
        "description": "a" * 1024,
        "license": "MIT",
        "compatibility": "a" * 500,
        "metadata": {"version": "1.0"},
        "allowed-tools": "Read Bash(git:*)",
        "x-runtime": {"mode": "native", "nested": [1, True]},
    }
    document = (
        "---\r\n" + yaml.safe_dump(metadata, allow_unicode=True).replace("\n", "\r\n") + ending
    )
    assert tar_utils.validate_skill_frontmatter(document, directory_name="cafe\u0301") == {
        "name": "café",
        "description": "a" * 1024,
    }
    edited = tar_utils.skill_document(
        "café", "New description", "New body", existing_content=document
    )
    rendered = yaml.safe_load(edited.split("---")[1])
    assert rendered["x-runtime"] == metadata["x-runtime"]
    assert rendered["metadata"] == {"version": "1.0"}


@pytest.mark.parametrize(
    "document",
    [
        "Instructions without metadata",
        "---\nname: example\n---",
        "---\n[name, example]\n---",
        "---\nname: [malformed\n---",
        "---\nname: first\nname: example\ndescription: valid\n---",
        "---\nname: example\ndescription: valid\nmetadata: {}\nmetadata: {}\n---",
    ],
)
def test_strict_frontmatter_does_not_accept_fallbacks_or_duplicate_fields(document: str) -> None:
    with pytest.raises(tar_utils.SkillTextValidationError):
        tar_utils.validate_skill_frontmatter(document)


def test_strict_frontmatter_requires_source_directory_match() -> None:
    with pytest.raises(tar_utils.SkillTextValidationError, match="parent directory"):
        tar_utils.validate_skill_frontmatter(
            "---\nname: example\ndescription: valid\n---", directory_name="different"
        )
