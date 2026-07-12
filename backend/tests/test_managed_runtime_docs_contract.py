from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).parents[2]
_DOC_PATHS = (
    _REPO_ROOT / "docs" / "managed-runtime.md",
    _REPO_ROOT / "docs" / "adr" / "0002-runtime-image-is-a-stable-capability-envelope.md",
)
_FORBIDDEN_NORMALIZED_TEXT = (
    "clawdi@agent-v2",
    "npm `agent-v2` dist-tag",
    "resolves the published cli",
    "npm dist-tag add",
)


def _normalized_text(path: Path) -> str:
    return " ".join(path.read_text(encoding="utf-8").casefold().split())


@pytest.mark.parametrize("path", _DOC_PATHS, ids=lambda path: path.name)
def test_hosted_runtime_docs_reject_floating_production_cli_policy(path: Path) -> None:
    text = _normalized_text(path)

    for forbidden in _FORBIDDEN_NORMALIZED_TEXT:
        assert forbidden not in text


def test_hosted_runtime_docs_pin_final_authority_boundaries() -> None:
    managed = _normalized_text(_DOC_PATHS[0])
    adr = _normalized_text(_DOC_PATHS[1])

    for required in (
        "exactly one enabled `openclaw` or `hermes`",
        "`locale.language`, `locale.timezone`",
        "codex remains a live-sync agent type",
        "`controlplane` contains only `cloudapiurl`",
        "`egressengine` and `egressprofiles` use closed schemas",
        "invalid stored egress json fails closed with `409`",
        "`mcp` and `tools` remain explicit pass-through projections",
        "standard npm `beta` dist-tag",
        "non-authoritative publication metadata",
        "`clawdi@beta` is rejected at both write and manifest-read boundaries",
    ):
        assert required in managed

    for required in (
        "standard npm `beta` dist-tag",
        "`beta` is non-authoritative publication metadata",
        "operator-supplied exact `clawdi@<semver>` package spec",
        "performs no npm dist-tag lookup",
        "cloud constructs the public manifest from that exact selection",
    ):
        assert required in adr
