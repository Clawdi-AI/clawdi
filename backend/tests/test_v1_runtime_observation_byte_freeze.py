from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).parents[2]
_BASELINE_PATH = Path(__file__).parent / "fixtures" / "v1_runtime_observation_baseline.json"
_TOP_LEVEL_SYMBOL = ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _symbol_bytes(source: bytes, node: _TOP_LEVEL_SYMBOL) -> bytes:
    lines = source.splitlines(keepends=True)
    start_lines = [node.lineno, *(decorator.lineno for decorator in node.decorator_list)]
    return b"".join(lines[min(start_lines) - 1 : node.end_lineno])


def _top_level_symbols(tree: ast.Module) -> dict[str, _TOP_LEVEL_SYMBOL]:
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _router_paths(tree: ast.Module) -> list[str]:
    paths: list[str] = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not decorator.args:
                continue
            function = decorator.func
            path = decorator.args[0]
            if (
                isinstance(function, ast.Attribute)
                and isinstance(function.value, ast.Name)
                and function.value.id == "router"
                and isinstance(path, ast.Constant)
                and isinstance(path.value, str)
            ):
                paths.append(path.value)
    return paths


def test_v1_runtime_observation_production_bytes_match_repository_baseline() -> None:
    """Keep the v1 observation boundary byte-frozen without pinning whole route modules."""

    baseline: dict[str, Any] = json.loads(_BASELINE_PATH.read_text(encoding="utf-8"))
    for relative_path, contract in baseline["files"].items():
        source = (_REPO_ROOT / relative_path).read_bytes()
        whole_file_sha256 = contract.get("whole_file_sha256")
        if whole_file_sha256 is not None:
            assert _sha256(source) == whole_file_sha256, relative_path

        if not any(
            name in contract
            for name in ("symbols", "forbidden_symbol_prefixes", "forbidden_route_fragments")
        ):
            continue
        tree = ast.parse(source, filename=relative_path)
        symbols = _top_level_symbols(tree)
        for symbol, expected_sha256 in contract.get("symbols", {}).items():
            assert symbol in symbols, f"frozen v1 symbol removed: {relative_path}:{symbol}"
            assert _sha256(_symbol_bytes(source, symbols[symbol])) == expected_sha256, (
                f"frozen v1 bytes changed: {relative_path}:{symbol}"
            )

        for prefix in contract.get("forbidden_symbol_prefixes", []):
            assert not any(symbol.startswith(prefix) for symbol in symbols), (
                f"old imperative-v2 schema re-entered v1: {relative_path}:{prefix}"
            )
        for fragment in contract.get("forbidden_route_fragments", []):
            assert not any(fragment in path for path in _router_paths(tree)), (
                f"old imperative-v2 route re-entered v1: {relative_path}:{fragment}"
            )
