"""Utilities for tar.gz skill archives: validation, creation, and extraction."""

from __future__ import annotations

import io
import re
import tarfile
from copy import copy
from pathlib import Path, PurePosixPath
from typing import TypeGuard

MAX_FILES = 5000
# Hard cap on TOTAL members (files + dirs + everything else). Without
# this, an archive can stay under MAX_FILES while carrying millions
# of empty directory entries — every member still costs CPU + memory
# during the validation walk and the eventual extract.
MAX_MEMBERS = 20_000
MAX_REGULAR_FILE_BYTES = 16 * 1024 * 1024  # 16 MB
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
_FRONTMATTER_BYTES_MAX = 64 * 1024
_FRONTMATTER_RE = re.compile(
    r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)",
    re.DOTALL,
)


class TarValidationError(ValueError):
    """Raised when a tar archive fails validation."""


class SkillTextValidationError(ValueError):
    """Raised when SKILL.md text cannot be stored safely."""


def _is_object_dict(value: object) -> TypeGuard[dict[object, object]]:
    """Narrow an untyped parser result after checking its runtime container."""
    return isinstance(value, dict)


def _is_object_collection(
    value: object,
) -> TypeGuard[list[object] | tuple[object, ...] | set[object]]:
    return isinstance(value, (list, tuple, set))


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
                if any(part.lower().startswith(".clawdi-managed") for part in parts):
                    raise TarValidationError(
                        f"Reserved management metadata not allowed: {member.name}"
                    )

                if member.isfile():
                    if member.size > MAX_REGULAR_FILE_BYTES:
                        raise TarValidationError(
                            "Regular file size exceeds "
                            f"{MAX_REGULAR_FILE_BYTES // (1024 * 1024)}MB: {member.name}"
                        )
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


def extract_skill_md(data: bytes, skill_key: str | None = None) -> str | None:
    """Extract SKILL.md content from a tar.gz archive.

    With a Skill key, requires its exact root document. Legacy callers may
    continue searching for the first SKILL.md at any depth.
    """
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            expected_name = f"{skill_key}/SKILL.md" if skill_key is not None else None
            for member in tf:
                if member.isfile() and (
                    member.name == expected_name
                    if expected_name is not None
                    else PurePosixPath(member.name).name == "SKILL.md"
                ):
                    f = tf.extractfile(member)
                    if f:
                        return f.read().decode("utf-8")
    except (OSError, UnicodeDecodeError, tarfile.TarError):
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


def reroot_skill_archive(data: bytes, source_skill_key: str, local_skill_key: str) -> bytes:
    """Repackage a validated Skill under its runtime-local directory name."""
    if source_skill_key == local_skill_key:
        return data
    validate_tar(data)
    source_parts = PurePosixPath(source_skill_key).parts
    local_parts = PurePosixPath(local_skill_key).parts
    if not source_parts or not local_parts:
        raise TarValidationError("Skill archive identity is invalid")

    output = io.BytesIO()
    try:
        with (
            tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source,
            tarfile.open(fileobj=output, mode="w:gz") as target,
        ):
            for member in source:
                member_parts = PurePosixPath(member.name).parts
                if not member_parts:
                    raise TarValidationError("Skill archive contains an invalid path")
                if (
                    len(member_parts) < len(source_parts)
                    and member_parts == source_parts[: len(member_parts)]
                ):
                    if not member.isdir():
                        raise TarValidationError("Skill archive root is invalid")
                    continue
                if member_parts[: len(source_parts)] != source_parts:
                    raise TarValidationError(
                        "Skill archive root does not match its source identity"
                    )

                rewritten = copy(member)
                rewritten.name = "/".join((*local_parts, *member_parts[len(source_parts) :]))
                if "path" in rewritten.pax_headers:
                    rewritten.pax_headers = {**rewritten.pax_headers, "path": rewritten.name}
                if member.isfile():
                    extracted = source.extractfile(member)
                    if extracted is None:
                        raise TarValidationError("Archive file could not be read")
                    target.addfile(rewritten, extracted)
                else:
                    target.addfile(rewritten)
    except tarfile.TarError as exc:
        raise TarValidationError("Invalid tar archive") from exc
    return output.getvalue()


def replace_skill_md(data: bytes, skill_key: str, content: str) -> tuple[bytes, int]:
    """Replace only SKILL.md while preserving every validated support file."""
    validate_tar(data)
    replacement_name = f"{skill_key}/SKILL.md"
    encoded = content.encode("utf-8")
    output = io.BytesIO()
    file_count = 0
    found = False
    try:
        with (
            tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source,
            tarfile.open(fileobj=output, mode="w:gz") as target,
        ):
            for member in source:
                if member.name == replacement_name and member.isfile():
                    if found:
                        raise TarValidationError("Archive contains duplicate SKILL.md entries")
                    found = True
                    continue
                if member.isfile():
                    extracted = source.extractfile(member)
                    if extracted is None:
                        raise TarValidationError("Archive file could not be read")
                    target.addfile(member, extracted)
                    file_count += 1
                else:
                    target.addfile(member)
            if not found:
                raise TarValidationError("Archive must contain SKILL.md at its declared root")
            info = tarfile.TarInfo(name=replacement_name)
            info.size = len(encoded)
            info.mode = 0o644
            info.mtime = 0
            target.addfile(info, io.BytesIO(encoded))
            file_count += 1
    except tarfile.TarError as exc:
        raise TarValidationError("Invalid tar archive") from exc
    return output.getvalue(), file_count


def _preservable_frontmatter(content: str) -> dict[object, object]:
    """Load bounded existing metadata without silently normalizing it away."""
    import yaml

    if "\x00" in content:
        raise SkillTextValidationError("SKILL.md must not contain NUL characters")
    match = _FRONTMATTER_RE.match(content)
    if match is None:
        if re.match(r"\A---[ \t]*(?:\r?\n|\Z)", content):
            raise SkillTextValidationError("Skill frontmatter is malformed")
        return {}
    raw = match.group(1)
    if len(raw.encode("utf-8")) > _FRONTMATTER_BYTES_MAX:
        raise SkillTextValidationError("Skill frontmatter exceeds the safe size limit")
    try:
        loaded: object = yaml.safe_load(raw)
    except (RecursionError, UnicodeError, yaml.YAMLError) as exc:
        raise SkillTextValidationError("Skill frontmatter is malformed") from exc
    if loaded is None:
        return {}
    if not _is_object_dict(loaded):
        raise SkillTextValidationError("Skill frontmatter must be a mapping")

    pending: list[object] = [loaded]
    seen: set[int] = set()
    visited = 0
    while pending:
        value = pending.pop()
        if isinstance(value, str):
            if "\x00" in value:
                raise SkillTextValidationError("Skill frontmatter must not contain NUL characters")
            continue
        if _is_object_dict(value):
            identity = id(value)
            if identity in seen:
                continue
            seen.add(identity)
            pending.extend(value.keys())
            pending.extend(value.values())
        elif _is_object_collection(value):
            identity = id(value)
            if identity in seen:
                continue
            seen.add(identity)
            pending.extend(value)
        visited += 1
        if visited > 10_000:
            raise SkillTextValidationError("Skill frontmatter is too complex")

    metadata = dict(loaded)
    try:
        rendered = yaml.safe_dump(
            metadata,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )
    except (RecursionError, UnicodeError, yaml.YAMLError) as exc:
        raise SkillTextValidationError("Skill frontmatter cannot be preserved safely") from exc
    if len(rendered.encode("utf-8")) > _FRONTMATTER_BYTES_MAX:
        raise SkillTextValidationError("Skill frontmatter exceeds the safe size limit")
    return metadata


def skill_document(
    name: str,
    description: str | None,
    instructions: str,
    *,
    existing_content: str | None = None,
) -> str:
    """Render Web fields while preserving non-editable imported metadata."""
    import yaml

    metadata = _preservable_frontmatter(existing_content) if existing_content is not None else {}
    metadata["name"] = name.strip()
    if description and description.strip():
        metadata["description"] = description.strip()
    else:
        metadata.pop("description", None)
    try:
        frontmatter = yaml.safe_dump(
            metadata,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        ).rstrip()
    except (RecursionError, UnicodeError, yaml.YAMLError) as exc:
        raise SkillTextValidationError("Skill frontmatter cannot be preserved safely") from exc
    if len(frontmatter.encode("utf-8")) > _FRONTMATTER_BYTES_MAX:
        raise SkillTextValidationError("Skill frontmatter exceeds the safe size limit")
    return f"---\n{frontmatter}\n---\n\n{instructions.strip()}\n"


def parse_frontmatter(content: str) -> dict[str, str]:
    """Extract YAML frontmatter from SKILL.md.

    Returns a flat dict[str, str] — only string-valued top-level keys are kept.
    Lists/maps/etc. are dropped (callers want simple metadata: name, description).
    Multiline scalars (`description: |\\n  ...`) are joined and stripped.
    """
    import yaml

    # PostgreSQL text values cannot contain NUL. Check the full document as
    # well as decoded YAML values below: a literal NUL can live in the body,
    # while a quoted YAML escape (for example ``"bad\0name"``) materializes
    # only after ``safe_load``. Rejecting at the document boundary keeps an
    # invalid Skill from reaching an ORM autoflush as an opaque 500.
    if "\x00" in content:
        raise SkillTextValidationError("SKILL.md must not contain NUL characters")

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
    if len(raw.encode("utf-8")) > _FRONTMATTER_BYTES_MAX:
        return {}

    try:
        loaded: object = yaml.safe_load(raw)
    except (RecursionError, UnicodeError, yaml.YAMLError):
        return {}

    if not _is_object_dict(loaded):
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
            normalized = value.strip()[:cap]
        elif isinstance(value, bool):
            # Match YAML wire form ("true"/"false") not Python's "True"/"False".
            # Callers comparing against literal "true" wouldn't expect Python
            # capitalization to leak through.
            normalized = "true" if value else "false"
        elif isinstance(value, (int, float)):
            normalized = str(value)[:cap]
        else:
            continue
        if "\x00" in key or "\x00" in normalized:
            raise SkillTextValidationError("Skill frontmatter must not contain NUL characters")
        fm[key] = normalized
    return fm
