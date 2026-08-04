import ast
import json
import os
import subprocess
from pathlib import Path

import pytest

from scripts import type_governance


def run_git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def analysis(*, files: int = 1, errors: int = 0, diagnostics: list[object] | None = None) -> str:
    return json.dumps(
        {
            "version": type_governance.EXPECTED_VERSION,
            "generalDiagnostics": diagnostics or [],
            "summary": {
                "filesAnalyzed": files,
                "errorCount": errors,
                "warningCount": 0,
                "informationCount": 0,
            },
        }
    )


def test_changed_paths_preserve_first_seen_order_and_deduplicate() -> None:
    paths = type_governance.production_paths(
        [
            "backend/app/core/skill_key.py",
            "app/core/query_utils.py",
            "app/core/skill_key.py",
        ]
    )

    assert paths == ["app/core/skill_key.py", "app/core/query_utils.py"]


def test_changed_path_discovery_includes_direct_and_nested_app_files(tmp_path: Path) -> None:
    direct = tmp_path / "backend/app/main.py"
    nested = tmp_path / "backend/app/services/nested.py"
    nonproduction = tmp_path / "backend/tests/test_example.py"
    for path in (direct, nested, nonproduction):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("INITIAL = True\n", encoding="utf-8")
    run_git(tmp_path, "init")
    run_git(tmp_path, "config", "user.email", "type-governance@example.invalid")
    run_git(tmp_path, "config", "user.name", "Type Governance")
    run_git(tmp_path, "add", ".")
    run_git(tmp_path, "commit", "-m", "initial")
    base = run_git(tmp_path, "rev-parse", "HEAD")

    for path in (direct, nested, nonproduction):
        path.write_text("CHANGED = True\n", encoding="utf-8")
    run_git(tmp_path, "commit", "-am", "change files")
    head = run_git(tmp_path, "rev-parse", "HEAD")

    assert type_governance.discover_changed_production_paths(base, head, repo_root=tmp_path) == [
        "backend/app/main.py",
        "backend/app/services/nested.py",
    ]


@pytest.mark.parametrize(
    "paths",
    [[], ["tests/test_smoke.py"], ["app/core/query_utils.txt"], ["app/../tests/test_smoke.py"]],
)
def test_changed_paths_reject_empty_or_nonproduction_input(paths: list[str]) -> None:
    with pytest.raises(ValueError):
        type_governance.production_paths(paths)


def test_analysis_rejects_empty_analysis() -> None:
    with pytest.raises(ValueError, match="partial analysis"):
        type_governance.parse_analysis(analysis(files=0), expected_files=1)


def test_analysis_rejects_partial_analysis() -> None:
    with pytest.raises(ValueError, match="partial analysis"):
        type_governance.parse_analysis(analysis(files=1), expected_files=2)


@pytest.mark.parametrize(
    "payload",
    ["", "{}", json.dumps({"version": type_governance.EXPECTED_VERSION})],
)
def test_analysis_rejects_malformed_output(payload: str) -> None:
    with pytest.raises(ValueError, match="malformed or incomplete JSON"):
        type_governance.parse_analysis(payload, expected_files=1)


def test_config_mismatch_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    config = tmp_path / "pyproject.toml"
    config.write_text('[tool.basedpyright]\ntypeCheckingMode = "basic"\n', encoding="utf-8")
    monkeypatch.setattr(type_governance, "CONFIG", config)

    with pytest.raises(ValueError, match="configuration mismatch"):
        type_governance.validate_config()


def test_typing_exception_sets_accept_live_disjoint_paths() -> None:
    assert type_governance.STANDARD_ONLY == frozenset(
        {
            "app/services/file_store_s3.py",
            "app/services/memory_provider_mem0.py",
        }
    )
    assert type_governance.RUNTIME_OBSERVATION_COMPATIBILITY_ONLY == frozenset(
        {"app/routes/sessions.py"}
    )
    type_governance.validate_exception_sets(
        type_governance.PRODUCTION_FILES,
        type_governance.STANDARD_ONLY,
        type_governance.RUNTIME_OBSERVATION_COMPATIBILITY_ONLY,
    )


def test_typing_exception_sets_reject_overlap() -> None:
    path = "app/routes/sessions.py"
    with pytest.raises(ValueError, match="overlap"):
        type_governance.validate_exception_sets(
            [path],
            frozenset({path}),
            frozenset({path}),
        )


@pytest.mark.parametrize("exception_kind", ["standard", "runtime-observation"])
def test_typing_exception_sets_reject_stale_paths(exception_kind: str) -> None:
    stale = frozenset({"app/not_owned.py"})
    with pytest.raises(ValueError, match="stale"):
        type_governance.validate_exception_sets(
            type_governance.PRODUCTION_FILES,
            stale if exception_kind == "standard" else frozenset(),
            stale if exception_kind == "runtime-observation" else frozenset(),
        )


def strict_config(*, strict: list[str], include: list[str] | None = None) -> dict[str, object]:
    return {
        "include": include or list(type_governance.EXPECTED_CONFIG["include"]),
        "strict": strict,
    }


def test_strict_paths_accept_audited_production_set() -> None:
    type_governance.validate_strict_paths(
        strict_config(strict=list(type_governance.EXPECTED_CONFIG["strict"]))
    )


def test_strict_paths_reject_unsorted_paths() -> None:
    with pytest.raises(ValueError, match="sorted"):
        type_governance.validate_strict_paths(
            strict_config(strict=list(reversed(type_governance.EXPECTED_CONFIG["strict"])))
        )


def test_strict_paths_reject_duplicates() -> None:
    path = type_governance.EXPECTED_CONFIG["strict"][0]
    with pytest.raises(ValueError, match="duplicates"):
        type_governance.validate_strict_paths(strict_config(strict=[path, path]))


def test_strict_paths_reject_non_owned_paths() -> None:
    with pytest.raises(ValueError, match="subset"):
        type_governance.validate_strict_paths(strict_config(strict=["app/not_owned.py"]))


def test_strict_paths_reject_nonproduction_paths() -> None:
    path = "tests/test_type_governance.py"
    with pytest.raises(ValueError, match="owned production"):
        type_governance.validate_strict_paths(strict_config(strict=[path]))


def install_analyzer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    payload: str,
    exit_code: int,
) -> None:
    executable = tmp_path / "basedpyright"
    executable.write_text(
        f"#!/bin/sh\nprintf '%s' '{payload}'\nexit {exit_code}\n",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")


def test_gate_rejects_diagnostics(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    payload = analysis(files=1, errors=1, diagnostics=[{"severity": "error"}])
    install_analyzer(tmp_path, monkeypatch, payload=payload, exit_code=0)

    with pytest.raises(ValueError, match="reported diagnostics"):
        type_governance.analyze(["app/core/query_utils.py"], gating=True)


def test_gate_reports_stdout_diagnostics_for_exit_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = analysis(
        files=1,
        errors=1,
        diagnostics=[{"severity": "error", "message": "typed failure"}],
    )
    install_analyzer(tmp_path, monkeypatch, payload=payload, exit_code=1)

    with pytest.raises(ValueError) as exc_info:
        type_governance.analyze(["app/core/query_utils.py"], gating=True)

    message = str(exc_info.value)
    assert "analyzer exited 1 with diagnostics" in message
    assert "typed failure" in message
    assert '"errorCount": 1' in message
    assert "no stderr" not in message


def test_gate_rejects_nonzero_exit_without_diagnostics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_analyzer(tmp_path, monkeypatch, payload=analysis(), exit_code=2)

    with pytest.raises(ValueError, match="analyzer exited 2"):
        type_governance.analyze(["app/core/query_utils.py"], gating=True)


def exception_diagnostics(paths: list[str]) -> list[dict[str, object]]:
    return [{"file": str(type_governance.BACKEND_ROOT / path)} for path in paths]


def runtime_observation_compatibility_diagnostics() -> list[dict[str, object]]:
    diagnostics: list[dict[str, object]] = []
    for (
        path,
        expected_symbols,
    ) in type_governance.EXPECTED_RUNTIME_OBSERVATION_COMPATIBILITY_DIAGNOSTICS.items():
        source = (type_governance.BACKEND_ROOT / path).read_bytes()
        tree = ast.parse(source, filename=path)
        symbols = {
            node.name: node
            for node in tree.body
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        }
        for symbol, rule_counts in expected_symbols.items():
            line = symbols[symbol].lineno - 1
            for rule, count in rule_counts.items():
                diagnostics.extend(
                    {
                        "file": str(type_governance.BACKEND_ROOT / path),
                        "range": {
                            "start": {"line": line, "character": 0},
                            "end": {"line": line, "character": 1},
                        },
                        "rule": rule,
                    }
                    for _ in range(count)
                )
    return diagnostics


def expected_exception_diagnostics() -> list[dict[str, object]]:
    diagnostics = [
        diagnostic
        for path in sorted(type_governance.STANDARD_ONLY)
        for diagnostic in exception_diagnostics(
            [path] * type_governance.EXPECTED_STRICT_EXCEPTION_DIAGNOSTICS[path]
        )
    ]
    return diagnostics + runtime_observation_compatibility_diagnostics()


def test_strict_exception_audit_reports_standard_and_compatibility_boundaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = sorted(
        type_governance.STANDARD_ONLY | type_governance.RUNTIME_OBSERVATION_COMPATIBILITY_ONLY
    )
    diagnostics = expected_exception_diagnostics()
    install_analyzer(
        tmp_path,
        monkeypatch,
        payload=analysis(
            files=len(paths),
            errors=len(diagnostics),
            diagnostics=diagnostics,
        ),
        exit_code=1,
    )

    result = type_governance.strict_exception_audit()

    assert result["standardOnly"] == {
        path: type_governance.EXPECTED_STRICT_EXCEPTION_DIAGNOSTICS[path]
        for path in sorted(type_governance.STANDARD_ONLY)
    }
    assert result["runtimeObservationCompatibilityOnly"] == (
        type_governance.EXPECTED_RUNTIME_OBSERVATION_COMPATIBILITY_DIAGNOSTICS
    )


def test_strict_exception_audit_rejects_strict_clean_stale_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = sorted(
        type_governance.STANDARD_ONLY | type_governance.RUNTIME_OBSERVATION_COMPATIBILITY_ONLY
    )
    diagnostics = [
        diagnostic
        for diagnostic in expected_exception_diagnostics()
        if diagnostic["file"]
        != str(type_governance.BACKEND_ROOT / "app/services/memory_provider_mem0.py")
    ]
    install_analyzer(
        tmp_path,
        monkeypatch,
        payload=analysis(
            files=len(paths),
            errors=len(diagnostics),
            diagnostics=diagnostics,
        ),
        exit_code=1,
    )

    with pytest.raises(ValueError, match="strict-clean typing exceptions are stale"):
        type_governance.strict_exception_audit()


def test_strict_exception_audit_rejects_new_diagnostic_debt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = sorted(
        type_governance.STANDARD_ONLY | type_governance.RUNTIME_OBSERVATION_COMPATIBILITY_ONLY
    )
    diagnostics = expected_exception_diagnostics() + exception_diagnostics(
        ["app/services/memory_provider_mem0.py"]
    )
    install_analyzer(
        tmp_path,
        monkeypatch,
        payload=analysis(
            files=len(paths),
            errors=len(diagnostics),
            diagnostics=diagnostics,
        ),
        exit_code=1,
    )

    with pytest.raises(ValueError, match="strict exception diagnostic inventory mismatch"):
        type_governance.strict_exception_audit()


def test_strict_exception_audit_rejects_diagnostic_outside_compatibility_symbols(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = sorted(
        type_governance.STANDARD_ONLY | type_governance.RUNTIME_OBSERVATION_COMPATIBILITY_ONLY
    )
    diagnostics = expected_exception_diagnostics()
    compatibility_diagnostic = next(
        diagnostic for diagnostic in diagnostics if "range" in diagnostic
    )
    source = (type_governance.BACKEND_ROOT / "app/routes/sessions.py").read_bytes()
    tree = ast.parse(source, filename="app/routes/sessions.py")
    non_compatibility_symbol = next(
        node
        for node in tree.body
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "_bound_env_id"
    )
    line = non_compatibility_symbol.lineno - 1
    compatibility_diagnostic["range"] = {
        "start": {"line": line, "character": 0},
        "end": {"line": line, "character": 1},
    }
    install_analyzer(
        tmp_path,
        monkeypatch,
        payload=analysis(
            files=len(paths),
            errors=len(diagnostics),
            diagnostics=diagnostics,
        ),
        exit_code=1,
    )

    with pytest.raises(
        ValueError,
        match="escaped its expected frozen symbol",
    ):
        type_governance.strict_exception_audit()


@pytest.mark.parametrize(
    "case",
    [
        "missing-start",
        "missing-end",
        "malformed-start",
        "malformed-end",
        "missing-start-character",
        "missing-end-character",
        "bool",
        "negative",
        "invalid-type",
        "reversed",
        "cross-symbol",
        "module-level",
    ],
)
def test_compatibility_diagnostic_location_rejects_invalid_ranges(case: str) -> None:
    path = "app/routes/sessions.py"
    all_ranges = type_governance._top_level_symbol_ranges(path)
    expected_symbols = type_governance.EXPECTED_RUNTIME_OBSERVATION_COMPATIBILITY_DIAGNOSTICS[path]
    symbol_ranges = {symbol: all_ranges[symbol] for symbol in expected_symbols}
    binding_start = symbol_ranges["_runtime_desired_provider_binding"][0]
    enabled_start = symbol_ranges["_enabled_runtime_names"][0]

    def point(position: tuple[int, int]) -> dict[str, int]:
        return {"line": position[0], "character": position[1]}

    start = point(binding_start)
    end = {"line": binding_start[0], "character": binding_start[1] + 1}
    invalid_ranges: dict[str, object] = {
        "missing-start": {"end": end},
        "missing-end": {"start": start},
        "malformed-start": {"start": [], "end": end},
        "malformed-end": {"start": start, "end": []},
        "missing-start-character": {
            "start": {"line": binding_start[0]},
            "end": end,
        },
        "missing-end-character": {
            "start": start,
            "end": {"line": binding_start[0]},
        },
        "bool": {
            "start": {"line": True, "character": binding_start[1]},
            "end": end,
        },
        "negative": {
            "start": start,
            "end": {"line": binding_start[0], "character": -1},
        },
        "invalid-type": {
            "start": start,
            "end": {"line": "0", "character": binding_start[1]},
        },
        "reversed": {
            "start": end,
            "end": start,
        },
        "cross-symbol": {
            "start": start,
            "end": point(enabled_start),
        },
        "module-level": {
            "start": {"line": 0, "character": 0},
            "end": {"line": 0, "character": 1},
        },
    }
    expected_errors = {
        "missing-start": "invalid range start",
        "missing-end": "invalid range end",
        "malformed-start": "invalid range start",
        "malformed-end": "invalid range end",
        "missing-start-character": "invalid range start",
        "missing-end-character": "invalid range end",
        "bool": "invalid range start",
        "negative": "invalid range end",
        "invalid-type": "invalid range end",
        "reversed": "reversed range",
        "cross-symbol": "escaped its expected frozen symbol",
        "module-level": "escaped its expected frozen symbol",
    }

    with pytest.raises(ValueError, match=expected_errors[case]):
        type_governance._compatibility_diagnostic_location(
            path,
            {
                "rule": "reportUnknownParameterType",
                "range": invalid_ranges[case],
            },
            symbol_ranges,
        )


def test_strict_exception_audit_rejects_compatibility_rule_drift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = sorted(
        type_governance.STANDARD_ONLY | type_governance.RUNTIME_OBSERVATION_COMPATIBILITY_ONLY
    )
    diagnostics = expected_exception_diagnostics()
    compatibility_diagnostic = next(
        diagnostic for diagnostic in diagnostics if "range" in diagnostic
    )
    compatibility_diagnostic["rule"] = "reportUnexpectedCompatibilityDebt"
    install_analyzer(
        tmp_path,
        monkeypatch,
        payload=analysis(
            files=len(paths),
            errors=len(diagnostics),
            diagnostics=diagnostics,
        ),
        exit_code=1,
    )

    with pytest.raises(
        ValueError,
        match="runtime-observation compatibility diagnostic inventory mismatch",
    ):
        type_governance.strict_exception_audit()
