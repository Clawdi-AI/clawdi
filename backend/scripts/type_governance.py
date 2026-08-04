"""Fail-closed BasedPyright gates and a complete non-gating inventory."""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
import tempfile
import tomllib
from collections.abc import Sequence
from pathlib import Path
from typing import TypedDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
CONFIG = BACKEND_ROOT / "pyproject.toml"
OWNED_EXCLUSIONS: frozenset[str] = frozenset()
OWNED_INCLUDE = [
    "app/__init__.py",
    "app/core",
    "app/main.py",
    "app/middleware",
    "app/models",
    "app/routes/__init__.py",
    "app/routes/a*.py",
    "app/routes/c*.py",
    "app/routes/channel_routers",
    "app/routes/d*.py",
    "app/routes/m*.py",
    "app/routes/p*.py",
    "app/routes/runtime.py",
    "app/routes/s*.py",
    "app/routes/v*.py",
    "app/runtime_entrypoint.py",
    "app/schemas",
    "app/services/__init__.py",
    "app/services/a*.py",
    "app/services/c*.py",
    "app/services/d*.py",
    "app/services/e*.py",
    "app/services/f*.py",
    "app/services/h*.py",
    "app/services/memory*.py",
    "app/services/metrics*.py",
    "app/services/p*.py",
    "app/services/r*.py",
    "app/services/s*.py",
    "app/services/t*.py",
    "app/services/u*.py",
    "app/services/v*.py",
    "app/services/w*.py",
    "app/tasks",
    "app/workers",
]
STANDARD_ONLY = frozenset(
    {
        # Both adapters remain in the zero-diagnostic owned gate. Their strict
        # debt is limited to pinned upstream packages that do not publish
        # complete typed construction/import boundaries.
        "app/services/file_store_s3.py",
        "app/services/memory_provider_mem0.py",
    }
)
RUNTIME_OBSERVATION_COMPATIBILITY_ONLY = frozenset(
    {
        # Repository-owned byte hashes protect the pre-v2 runtime-observation
        # and heartbeat compatibility symbols in this otherwise canonical v1
        # API module. BasedPyright strictness is file-scoped, so the exception
        # audit below pins every remaining diagnostic to those exact symbols.
        "app/routes/sessions.py",
    }
)
EXPECTED_RUNTIME_OBSERVATION_COMPATIBILITY_DIAGNOSTICS = {
    "app/routes/sessions.py": {
        "_runtime_desired_provider_binding": {
            "reportMissingTypeArgument": 1,
            "reportUnknownArgumentType": 4,
            "reportUnknownParameterType": 1,
            "reportUnknownVariableType": 2,
        },
        "_enabled_runtime_names": {
            "reportMissingTypeArgument": 1,
            "reportUnknownArgumentType": 1,
            "reportUnknownMemberType": 1,
            "reportUnknownParameterType": 1,
            "reportUnknownVariableType": 2,
        },
        "_bounded_runtime_observed": {
            "reportUnknownVariableType": 1,
        },
    }
}
EXPECTED_STRICT_EXCEPTION_DIAGNOSTICS = {
    "app/services/file_store_s3.py": 2,
    "app/services/memory_provider_mem0.py": 19,
    **{
        path: sum(
            count
            for symbol_diagnostics in symbols.values()
            for count in symbol_diagnostics.values()
        )
        for path, symbols in EXPECTED_RUNTIME_OBSERVATION_COMPATIBILITY_DIAGNOSTICS.items()
    },
}
PRODUCTION_FILES = tuple(
    sorted(
        path.relative_to(BACKEND_ROOT).as_posix() for path in (BACKEND_ROOT / "app").rglob("*.py")
    )
)
OWNED_PRODUCTION_FILES = tuple(path for path in PRODUCTION_FILES if path not in OWNED_EXCLUSIONS)
STRICT_PRODUCTION_FILES = tuple(
    path
    for path in PRODUCTION_FILES
    if path not in STANDARD_ONLY | RUNTIME_OBSERVATION_COMPATIBILITY_ONLY
)
EXPECTED_CONFIG = {
    "typeCheckingMode": "standard",
    "pythonVersion": "3.12",
    "include": OWNED_INCLUDE,
    "strict": list(STRICT_PRODUCTION_FILES),
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


type SourcePosition = tuple[int, int]
type SourceRange = tuple[SourcePosition, SourcePosition]


def validate_config() -> None:
    validate_exception_sets(
        PRODUCTION_FILES,
        STANDARD_ONLY,
        RUNTIME_OBSERVATION_COMPATIBILITY_ONLY,
    )
    exception_paths = STANDARD_ONLY | RUNTIME_OBSERVATION_COMPATIBILITY_ONLY
    if set(EXPECTED_STRICT_EXCEPTION_DIAGNOSTICS) != exception_paths:
        raise ValueError("strict exception diagnostic inventory paths do not match exceptions")
    if (
        set(EXPECTED_RUNTIME_OBSERVATION_COMPATIBILITY_DIAGNOSTICS)
        != RUNTIME_OBSERVATION_COMPATIBILITY_ONLY
    ):
        raise ValueError(
            "runtime-observation compatibility diagnostic paths do not match exceptions"
        )
    with CONFIG.open("rb") as handle:
        document = tomllib.load(handle)
    configured = document.get("tool", {}).get("basedpyright")
    if isinstance(configured, dict) and "strict" in configured:
        validate_strict_paths(configured)
    if configured != EXPECTED_CONFIG:
        raise ValueError(
            "BasedPyright configuration mismatch; expected exactly "
            f"{json.dumps(EXPECTED_CONFIG, sort_keys=True)}"
        )


def validate_exception_sets(
    production_files: Sequence[str],
    standard_only: frozenset[str],
    runtime_observation_compatibility_only: frozenset[str],
) -> None:
    production = set(production_files)
    overlap = standard_only & runtime_observation_compatibility_only
    if overlap:
        raise ValueError(f"typing exception sets overlap: {sorted(overlap)}")
    stale = (standard_only | runtime_observation_compatibility_only) - production
    if stale:
        raise ValueError(f"stale typing exception paths: {sorted(stale)}")


def validate_strict_paths(configured: dict[str, object]) -> None:
    owned = configured.get("include")
    strict = configured.get("strict")
    if owned != OWNED_INCLUDE:
        raise ValueError("BasedPyright owned include does not match the audited production set")
    if (
        not isinstance(strict, list)
        or not strict
        or not all(isinstance(path, str) for path in strict)
    ):
        raise ValueError("BasedPyright strict must be a non-empty path list")
    if strict != sorted(strict):
        raise ValueError("BasedPyright strict paths must be sorted")
    if len(strict) != len(set(strict)):
        raise ValueError("BasedPyright strict paths must not contain duplicates")
    if not set(strict).issubset(OWNED_PRODUCTION_FILES):
        raise ValueError("BasedPyright strict paths must be a subset of owned production files")
    if strict != list(STRICT_PRODUCTION_FILES):
        raise ValueError("BasedPyright strict paths do not match the audited production set")
    production_paths(strict)


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


def analyze(paths: Sequence[str], *, gating: bool, config: Path = CONFIG) -> Analysis:
    completed = subprocess.run(
        ["basedpyright", "--outputjson", "--project", str(config), *paths],
        cwd=BACKEND_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    analysis = parse_analysis(completed.stdout, len(paths))
    if gating and completed.returncode == 1:
        diagnostic_report = {
            "generalDiagnostics": analysis["generalDiagnostics"],
            "summary": analysis["summary"],
        }
        raise ValueError(
            f"analyzer exited 1 with diagnostics: {json.dumps(diagnostic_report, sort_keys=True)}"
        )
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


def _top_level_symbol_ranges(path: str) -> dict[str, SourceRange]:
    source = (BACKEND_ROOT / path).read_bytes()
    tree = ast.parse(source, filename=path)
    ranges: dict[str, SourceRange] = {}
    for node in tree.body:
        if not isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.end_lineno is None or node.end_col_offset is None:
            raise ValueError(f"top-level symbol has no end position: {path}:{node.name}")
        starts = [(node.lineno - 1, node.col_offset)]
        starts.extend(
            (decorator.lineno - 1, max(0, decorator.col_offset - 1))
            for decorator in node.decorator_list
        )
        ranges[node.name] = (min(starts), (node.end_lineno - 1, node.end_col_offset))
    return ranges


def _diagnostic_position(path: str, name: str, value: object) -> SourcePosition:
    if not isinstance(value, dict):
        raise ValueError(
            f"runtime-observation compatibility diagnostic has an invalid {name}: {path}"
        )
    line = value.get("line")
    character = value.get("character")
    if (
        isinstance(line, bool)
        or not isinstance(line, int)
        or line < 0
        or isinstance(character, bool)
        or not isinstance(character, int)
        or character < 0
    ):
        raise ValueError(
            f"runtime-observation compatibility diagnostic has an invalid {name}: {path}"
        )
    return line, character


def _diagnostic_range(path: str, value: object) -> SourceRange:
    if not isinstance(value, dict):
        raise ValueError(
            f"runtime-observation compatibility diagnostic has an invalid range: {path}"
        )
    start = _diagnostic_position(path, "range start", value.get("start"))
    end = _diagnostic_position(path, "range end", value.get("end"))
    if start > end:
        raise ValueError(
            f"runtime-observation compatibility diagnostic has a reversed range: {path}"
        )
    return start, end


def _compatibility_diagnostic_location(
    path: str,
    diagnostic: dict[object, object],
    symbol_ranges: dict[str, SourceRange],
) -> tuple[str, str]:
    rule = diagnostic.get("rule")
    if not isinstance(rule, str):
        raise ValueError(f"runtime-observation compatibility diagnostic omitted its rule: {path}")
    start, end = _diagnostic_range(path, diagnostic.get("range"))
    symbol = next(
        (
            name
            for name, (symbol_start, symbol_end) in symbol_ranges.items()
            if symbol_start <= start and end <= symbol_end
        ),
        None,
    )
    if symbol is None:
        raise ValueError(
            "runtime-observation compatibility diagnostic escaped its expected frozen symbol: "
            f"{path}:{start[0]}:{start[1]}-{end[0]}:{end[1]}:{rule}"
        )
    return symbol, rule


def strict_exception_audit() -> dict[str, object]:
    paths = sorted(STANDARD_ONLY | RUNTIME_OBSERVATION_COMPATIBILITY_ONLY)
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix=".basedpyright-strict-audit-",
        suffix=".json",
        dir=BACKEND_ROOT,
    ) as handle:
        json.dump(
            {
                "typeCheckingMode": "strict",
                "pythonVersion": EXPECTED_CONFIG["pythonVersion"],
                "include": [],
            },
            handle,
        )
        handle.flush()
        analysis = analyze(paths, gating=False, config=Path(handle.name))

    counts = dict.fromkeys(paths, 0)
    symbol_ranges: dict[str, dict[str, SourceRange]] = {}
    for path, expected_symbols in EXPECTED_RUNTIME_OBSERVATION_COMPATIBILITY_DIAGNOSTICS.items():
        ranges = _top_level_symbol_ranges(path)
        missing = set(expected_symbols) - set(ranges)
        if missing:
            raise ValueError(f"runtime-observation compatibility symbols are missing: {missing}")
        symbol_ranges[path] = {symbol: ranges[symbol] for symbol in expected_symbols}
    compatibility_counts: dict[str, dict[str, dict[str, int]]] = {
        path: {} for path in RUNTIME_OBSERVATION_COMPATIBILITY_ONLY
    }
    for diagnostic in analysis["generalDiagnostics"]:
        if not isinstance(diagnostic, dict):
            raise ValueError("strict exception audit returned a malformed diagnostic")
        raw_path = diagnostic.get("file")
        if not isinstance(raw_path, str):
            raise ValueError("strict exception audit diagnostic omitted its file")
        try:
            path = Path(raw_path).resolve().relative_to(BACKEND_ROOT).as_posix()
        except ValueError as exc:
            raise ValueError(f"strict exception audit escaped the backend: {raw_path}") from exc
        if path not in counts:
            raise ValueError(f"strict exception audit reported an unexpected file: {path}")
        counts[path] += 1
        if path in RUNTIME_OBSERVATION_COMPATIBILITY_ONLY:
            symbol, rule = _compatibility_diagnostic_location(
                path,
                diagnostic,
                symbol_ranges[path],
            )
            rule_counts = compatibility_counts[path].setdefault(symbol, {})
            rule_counts[rule] = rule_counts.get(rule, 0) + 1

    stale = [path for path, count in counts.items() if count == 0]
    if stale:
        raise ValueError(f"strict-clean typing exceptions are stale: {stale}")
    if counts != EXPECTED_STRICT_EXCEPTION_DIAGNOSTICS:
        raise ValueError(
            "strict exception diagnostic inventory mismatch: "
            f"expected={EXPECTED_STRICT_EXCEPTION_DIAGNOSTICS} observed={counts}"
        )
    if compatibility_counts != EXPECTED_RUNTIME_OBSERVATION_COMPATIBILITY_DIAGNOSTICS:
        raise ValueError(
            "runtime-observation compatibility diagnostic inventory mismatch: "
            f"expected={EXPECTED_RUNTIME_OBSERVATION_COMPATIBILITY_DIAGNOSTICS} "
            f"observed={compatibility_counts}"
        )
    return {
        "basedpyrightVersion": EXPECTED_VERSION,
        "mode": "strict exception audit",
        "standardOnly": {path: counts[path] for path in sorted(STANDARD_ONLY)},
        "runtimeObservationCompatibilityOnly": compatibility_counts,
        "totalDiagnostics": sum(counts.values()),
    }


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
    subparsers.add_parser("strict")
    subparsers.add_parser("exceptions")
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
            result: object = analyze(OWNED_PRODUCTION_FILES, gating=True)["summary"]
        elif args.command == "strict":
            result = analyze(STRICT_PRODUCTION_FILES, gating=True)["summary"]
        elif args.command == "exceptions":
            result = strict_exception_audit()
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
