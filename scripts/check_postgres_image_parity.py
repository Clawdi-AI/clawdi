#!/usr/bin/env python3
"""Fail closed when PostgreSQL test or deploy image references drift."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUTHORITY = ROOT / "config/postgres-image.txt"
PIN_PATTERN = re.compile(r"ghcr\.io/clawdi-ai/postgres-pgbackrest:pg18@sha256:[0-9a-f]{64}")
MAPPING_LINE = re.compile(r"^( *)([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$")


class ParityError(RuntimeError):
    """A checked PostgreSQL image reference diverged from its authority."""


def mapping_scalars(content: str) -> list[tuple[tuple[str, ...], str]]:
    """Return scalar assignments with their indentation-derived YAML paths."""
    stack: list[tuple[int, str]] = []
    assignments: list[tuple[tuple[str, ...], str]] = []
    for line in content.splitlines():
        match = MAPPING_LINE.match(line)
        if match is None:
            continue
        indent = len(match.group(1))
        key = match.group(2)
        raw_value = (match.group(3) or "").strip()
        while stack and stack[-1][0] >= indent:
            stack.pop()
        path = tuple(item[1] for item in stack) + (key,)
        value = raw_value.split(" #", 1)[0].strip()
        if value:
            assignments.append((path, value))
        else:
            stack.append((indent, key))
    return assignments


def values_at_suffix(
    assignments: list[tuple[tuple[str, ...], str]], suffix: tuple[str, ...]
) -> list[str]:
    return [value for path, value in assignments if path[-len(suffix) :] == suffix]


def validate_image_assignments(authority: str, contents: dict[str, str] | None = None) -> None:
    """Validate every test and production PostgreSQL image field."""
    expected_services = {
        ".github/workflows/backend-ci.yml": (
            ("services", "postgres", "image"),
            ("services", "postgres", "env", "PGDATA"),
        ),
        "docker-compose.test.yml": (
            ("services", "postgres", "image"),
            ("services", "postgres", "environment", "PGDATA"),
        ),
    }
    if contents is None:
        filenames = (*expected_services, "config/deploy.yml")
        contents = {
            filename: (ROOT / filename).read_text(encoding="utf-8") for filename in filenames
        }

    for filename, (image_suffix, pgdata_suffix) in expected_services.items():
        assignments = mapping_scalars(contents[filename])
        if values_at_suffix(assignments, image_suffix) != [authority]:
            raise ParityError(f"{filename} PostgreSQL image must equal authority")
        if values_at_suffix(assignments, pgdata_suffix):
            raise ParityError(f"{filename} must exercise the pinned image's PGDATA default")

    deploy_assignments = mapping_scalars(contents["config/deploy.yml"])
    primary = values_at_suffix(deploy_assignments, ("accessories", "postgres", "image"))
    if primary != [f"&postgres-image {authority}"]:
        raise ParityError("config/deploy.yml postgres image anchor must equal authority")
    backup = values_at_suffix(deploy_assignments, ("accessories", "postgres-backup", "image"))
    if backup != ["*postgres-image"]:
        raise ParityError("config/deploy.yml postgres-backup must reuse postgres anchor")


def main() -> None:
    authority = AUTHORITY.read_text(encoding="utf-8").strip()
    if PIN_PATTERN.fullmatch(authority) is None:
        raise SystemExit(
            "PostgreSQL image parity failed: config/postgres-image.txt must "
            "contain one immutable pg18 image with exactly 64 digest hex characters"
        )
    try:
        validate_image_assignments(authority)
    except ParityError as error:
        raise SystemExit(f"PostgreSQL image parity failed: {error}") from error
    print(f"PostgreSQL image parity passed: {authority}")


if __name__ == "__main__":
    main()
