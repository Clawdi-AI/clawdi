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


def strict_config(*, strict: list[str], include: list[str] | None = None) -> dict[str, object]:
    return {
        "include": include or list(type_governance.EXPECTED_CONFIG["include"]),
        "strict": strict,
    }


def test_strict_paths_accept_sorted_production_subset() -> None:
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
        type_governance.validate_strict_paths(strict_config(strict=["app/main.py"]))


def test_strict_paths_reject_nonproduction_paths() -> None:
    path = "tests/test_type_governance.py"
    with pytest.raises(ValueError, match="owned production"):
        type_governance.validate_strict_paths(strict_config(strict=[path], include=[path]))


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


def test_gate_rejects_nonzero_exit_without_diagnostics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_analyzer(tmp_path, monkeypatch, payload=analysis(), exit_code=2)

    with pytest.raises(ValueError, match="analyzer exited 2"):
        type_governance.analyze(["app/core/query_utils.py"], gating=True)
