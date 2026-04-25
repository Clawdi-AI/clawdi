"""Utilities for tar.gz skill archives: validation, creation, and extraction."""

from __future__ import annotations

import io
import re
import tarfile
from pathlib import Path, PurePosixPath

MAX_FILES = 5000
MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024  # 200 MB
GZIP_MAGIC = b"\x1f\x8b"


class TarValidationError(ValueError):
    """Raised when a tar archive fails validation."""


def validate_tar(data: bytes) -> int:
    """Validate a tar.gz archive. Returns file count.

    Raises TarValidationError on invalid or dangerous archives.
    """
    if not data[:2] == GZIP_MAGIC:
        raise TarValidationError("Not a gzip-compressed archive")

    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            file_count = 0
            total_size = 0

            for member in tf:
                # Reject symlinks
                if member.issym() or member.islnk():
                    raise TarValidationError(f"Symlinks not allowed: {member.name}")

                # Reject absolute paths
                if member.name.startswith("/"):
                    raise TarValidationError(f"Absolute paths not allowed: {member.name}")

                # Reject path traversal
                parts = PurePosixPath(member.name).parts
                if ".." in parts:
                    raise TarValidationError(f"Path traversal not allowed: {member.name}")

                if member.isfile():
                    file_count += 1
                    total_size += member.size

                if file_count > MAX_FILES:
                    raise TarValidationError(f"Too many files: exceeds {MAX_FILES}")
                if total_size > MAX_DECOMPRESSED_BYTES:
                    raise TarValidationError(
                        f"Decompressed size exceeds {MAX_DECOMPRESSED_BYTES // (1024 * 1024)}MB"
                    )

            return file_count
    except tarfile.TarError as e:
        raise TarValidationError(f"Invalid tar archive: {e}") from e


def extract_skill_md(data: bytes) -> str | None:
    """Extract SKILL.md content from a tar.gz archive.

    Searches for any file named SKILL.md at any depth.
    """
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            for member in tf:
                if member.isfile() and PurePosixPath(member.name).name == "SKILL.md":
                    f = tf.extractfile(member)
                    if f:
                        return f.read().decode("utf-8")
    except tarfile.TarError:
        return None
    return None


def tar_from_dir(dir_path: Path) -> tuple[bytes, int]:
    """Create a tar.gz from a directory. Returns (tar_bytes, file_count)."""
    buf = io.BytesIO()
    file_count = 0

    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for file_path in sorted(dir_path.rglob("*")):
            if not file_path.is_file():
                continue
            rel = file_path.relative_to(dir_path.parent)
            tf.add(file_path, arcname=str(rel))
            file_count += 1

    return buf.getvalue(), file_count


def tar_from_content(skill_key: str, content: str) -> tuple[bytes, int]:
    """Wrap a single SKILL.md text into a tar.gz. Returns (tar_bytes, 1)."""
    buf = io.BytesIO()
    encoded = content.encode("utf-8")

    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        info = tarfile.TarInfo(name=f"{skill_key}/SKILL.md")
        info.size = len(encoded)
        tf.addfile(info, io.BytesIO(encoded))

    return buf.getvalue(), 1


def parse_frontmatter(content: str) -> dict[str, str]:
    """Extract YAML frontmatter from SKILL.md.

    Returns a flat dict[str, str] — only string-valued top-level keys are kept.
    Lists/maps/etc. are dropped (callers want simple metadata: name, description).
    Multiline scalars (`description: |\\n  ...`) are joined and stripped.
    """
    import yaml

    match = re.match(r"^---\s*\n(.*?)\n---\s*\n", content, re.DOTALL)
    if not match:
        return {}

    try:
        loaded = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return {}

    if not isinstance(loaded, dict):
        return {}

    fm: dict[str, str] = {}
    for key, value in loaded.items():
        if not isinstance(key, str):
            continue
        if isinstance(value, str):
            fm[key] = value.strip()
        elif isinstance(value, (int, float, bool)):
            fm[key] = str(value)
    return fm
