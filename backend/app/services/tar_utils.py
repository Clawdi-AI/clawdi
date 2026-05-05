"""Utilities for tar.gz skill archives: validation, creation, and extraction."""

from __future__ import annotations

import io
import re
import tarfile
from pathlib import Path, PurePosixPath

MAX_FILES = 5000
# Hard cap on TOTAL members (files + dirs + everything else). Without
# this, an archive can stay under MAX_FILES while carrying millions
# of empty directory entries — every member still costs CPU + memory
# during the validation walk and the eventual extract.
MAX_MEMBERS = 20_000
MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024  # 200 MB
# Cap that mirrors the per-route skill upload limit in
# routes/skills.py:_MAX_SKILL_TAR_BYTES. The marketplace
# install path needs the same ceiling so that it can't sneak in
# a larger tar than a direct-upload caller would.
MAX_SKILL_TAR_BYTES = 25 * 1024 * 1024  # 25 MB
GZIP_MAGIC = b"\x1f\x8b"

# Schema column widths the frontmatter values are eventually
# stored under. Keeping the bound here means we truncate at the
# parse boundary so a malformed SKILL.md never makes it down to
# the route's INSERT and turns into a database error.
_FM_NAME_MAX = 200
_FM_DESCRIPTION_MAX = 2000


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
            member_count = 0
            total_size = 0

            for member in tf:
                member_count += 1
                if member_count > MAX_MEMBERS:
                    raise TarValidationError(f"Too many archive members: exceeds {MAX_MEMBERS}")

                # Reject symlinks + hard links
                if member.issym() or member.islnk():
                    raise TarValidationError(f"Symlinks not allowed: {member.name}")

                # Reject anything that isn't a regular file or
                # directory: device nodes, FIFOs, character/block
                # specials. None of these belong in a skill archive
                # and most extractors will refuse them anyway, but
                # we'd rather reject at validate time than have an
                # extract-side surprise.
                if not (member.isfile() or member.isdir()):
                    raise TarValidationError(
                        f"Unsupported entry type ({member.type!r}): {member.name}"
                    )

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

    # Hard cap on the YAML block BEFORE handing it to the parser.
    # `safe_load` is reasonably hardened against billion-laughs
    # and similar bombs, but the safest tactic is "don't even
    # parse pathological input". 64 KiB fits any plausible
    # frontmatter (real-world skills are <1 KiB) and bounds
    # parser CPU/memory worst case.
    raw = match.group(1)
    _FRONTMATTER_BYTES_MAX = 64 * 1024
    if len(raw.encode("utf-8")) > _FRONTMATTER_BYTES_MAX:
        return {}

    try:
        loaded = yaml.safe_load(raw)
    except yaml.YAMLError:
        return {}

    if not isinstance(loaded, dict):
        return {}

    # Per-key truncation caps. Anything not listed here gets a
    # generic 8 KB fallback — well above any reasonable metadata
    # and well below "this is going to blow up Postgres".
    _per_key_caps: dict[str, int] = {
        "name": _FM_NAME_MAX,
        "description": _FM_DESCRIPTION_MAX,
    }
    _default_cap = 8 * 1024

    fm: dict[str, str] = {}
    for key, value in loaded.items():
        if not isinstance(key, str):
            continue
        cap = _per_key_caps.get(key, _default_cap)
        if isinstance(value, str):
            fm[key] = value.strip()[:cap]
        elif isinstance(value, bool):
            # Match YAML wire form ("true"/"false") not Python's "True"/"False".
            # Callers comparing against literal "true" wouldn't expect Python
            # capitalization to leak through.
            fm[key] = "true" if value else "false"
        elif isinstance(value, (int, float)):
            fm[key] = str(value)[:cap]
    return fm
