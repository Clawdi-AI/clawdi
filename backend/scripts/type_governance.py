"""Fail-closed BasedPyright gates and a complete non-gating inventory."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tomllib
from collections.abc import Sequence
from pathlib import Path
from typing import TypedDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
CONFIG = BACKEND_ROOT / "pyproject.toml"
EXPECTED_CONFIG = {
    "typeCheckingMode": "standard",
    "pythonVersion": "3.12",
    "include": [
        "app/core/query_utils.py",
        "app/core/skill_key.py",
        "app/services/composio.py",
        "app/services/embedding.py",
        "app/services/memory_extraction.py",
    ],
}
EXPECTED_VERSION = "1.39.9"
INVENTORY_AREAS = ("app", "tests", "scripts", "alembic")
PRODUCTION_PATHSPEC = ":(top,glob)backend/app/**/*.py"


class Summary(TypedDict):
    filesAnalyzed: int
    errorCount: int
    warningCount: int
    informationCount: int


class Analysis(TypedDict):
    version: str
    generalDiagnostics: list[object]
    summary: Summary


def validate_config() -> None:
    with CONFIG.open("rb") as handle:
        document = tomllib.load(handle)
    configured = document.get("tool", {}).get("basedpyright")
    if configured != EXPECTED_CONFIG:
        raise ValueError(
            "BasedPyright configuration mismatch; expected exactly "
            f"{json.dumps(EXPECTED_CONFIG, sort_keys=True)}"
        )


def production_paths(raw_paths: Sequence[str]) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()
    for raw_path in raw_paths:
        path = Path(raw_path)
        if path.is_absolute():
            raise ValueError(f"absolute paths are not allowed: {raw_path}")
        normalized = path.as_posix()
        if normalized.startswith("backend/"):
            normalized = normalized.removeprefix("backend/")
        candidate = Path(normalized)
        if candidate.parts[:1] != ("app",) or candidate.suffix != ".py" or ".." in candidate.parts:
            raise ValueError(f"not an owned production Python path: {raw_path}")
        resolved = (BACKEND_ROOT / candidate).resolve()
        if not resolved.is_relative_to(BACKEND_ROOT / "app") or not resolved.is_file():
            raise ValueError(f"production path does not resolve to a file: {raw_path}")
        canonical = resolved.relative_to(BACKEND_ROOT).as_posix()
        if canonical not in seen:
            seen.add(canonical)
            paths.append(canonical)
    if not paths:
        raise ValueError("changed-production analysis requires at least one Python file")
    return paths


def discover_changed_production_paths(
    base: str, head: str, *, repo_root: Path = REPO_ROOT
) -> list[str]:
    completed = subprocess.run(
        [
            "git",
            "diff",
            "--diff-filter=ACMR",
            "--name-only",
            "-z",
            base,
            head,
            "--",
            PRODUCTION_PATHSPEC,
        ],
        cwd=repo_root,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise ValueError(
            f"changed-path discovery exited {completed.returncode}: "
            f"{completed.stderr.strip() or 'no stderr'}"
        )
    return list(dict.fromkeys(path for path in completed.stdout.split("\0") if path))


def parse_analysis(stdout: str, expected_files: int) -> Analysis:
    try:
        payload = json.loads(stdout)
        version = payload["version"]
        diagnostics = payload["generalDiagnostics"]
        summary = payload["summary"]
        counts = {
            key: summary[key]
            for key in ("filesAnalyzed", "errorCount", "warningCount", "informationCount")
        }
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError("analyzer returned malformed or incomplete JSON") from exc
    if version != EXPECTED_VERSION:
        raise ValueError(f"analyzer version mismatch: {version!r}")
    if not isinstance(diagnostics, list) or any(
        isinstance(value, bool) or not isinstance(value, int) or value < 0
        for value in counts.values()
    ):
        raise ValueError("analyzer returned invalid diagnostics or summary counts")
    if counts["filesAnalyzed"] != expected_files:
        raise ValueError(
            f"partial analysis: expected {expected_files} files, analyzed {counts['filesAnalyzed']}"
        )
    return payload


def analyze(paths: Sequence[str], *, gating: bool) -> Analysis:
    completed = subprocess.run(
        ["basedpyright", "--outputjson", "--project", str(CONFIG), *paths],
        cwd=BACKEND_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    analysis = parse_analysis(completed.stdout, len(paths))
    if completed.returncode not in ({0} if gating else {0, 1}):
        raise ValueError(
            f"analyzer exited {completed.returncode}: {completed.stderr.strip() or 'no stderr'}"
        )
    if gating:
        summary = analysis["summary"]
        if analysis["generalDiagnostics"] or any(
            summary[key] for key in ("errorCount", "warningCount", "informationCount")
        ):
            raise ValueError("gating analysis reported diagnostics")
    return analysis


def inventory() -> dict[str, object]:
    areas: dict[str, Summary] = {}
    total: Summary = {
        "filesAnalyzed": 0,
        "errorCount": 0,
        "warningCount": 0,
        "informationCount": 0,
    }
    for area in INVENTORY_AREAS:
        paths = sorted(
            path.relative_to(BACKEND_ROOT).as_posix()
            for path in (BACKEND_ROOT / area).rglob("*.py")
        )
        if not paths:
            raise ValueError(f"inventory area is unexpectedly empty: {area}")
        summary = analyze(paths, gating=False)["summary"]
        areas[area] = summary
        for key in total:
            total[key] += summary[key]
    return {
        "basedpyrightVersion": EXPECTED_VERSION,
        "mode": "standard",
        "areas": areas,
        "total": total,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("owned")
    changed = subparsers.add_parser("changed")
    changed.add_argument("paths", nargs="*")
    changed_from = subparsers.add_parser("changed-from")
    changed_from.add_argument("base")
    changed_from.add_argument("head")
    subparsers.add_parser("inventory")
    args = parser.parse_args(argv)
    try:
        validate_config()
        if args.command == "owned":
            result: object = analyze(EXPECTED_CONFIG["include"], gating=True)["summary"]
        elif args.command == "changed":
            result = analyze(production_paths(args.paths), gating=True)["summary"]
        elif args.command == "changed-from":
            paths = discover_changed_production_paths(args.base, args.head)
            if paths:
                result = analyze(production_paths(paths), gating=True)["summary"]
            else:
                result = {"filesAnalyzed": 0, "message": "no changed production Python files"}
        else:
            result = inventory()
    except ValueError as exc:
        print(f"type-governance: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
