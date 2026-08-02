from __future__ import annotations

import pytest

from app.services.ai_provider_credentials import selected_runtime_binding


def _configured_runtime(provider_id: str) -> dict[str, object]:
    return {
        "enabled": True,
        "providerMode": "configured",
        "provider_ids": [provider_id],
        "primary_model": {
            "provider_id": provider_id,
            "model": "gpt-test",
        },
        "install": {"source": "official"},
    }


def test_selected_runtime_binding_returns_validated_provider_binding() -> None:
    binding = selected_runtime_binding({"openclaw": _configured_runtime("openai-compatible")})

    assert binding == ("openclaw", "openai-compatible")


@pytest.mark.parametrize(
    "runtimes",
    (
        None,
        [],
        {1: _configured_runtime("openai-compatible")},
        {"unsupported": _configured_runtime("openai-compatible")},
        {
            "codex": _configured_runtime("openai-compatible"),
            "openclaw": _configured_runtime("openai-compatible"),
        },
        {"openclaw": {"enabled": True}},
    ),
)
def test_selected_runtime_binding_rejects_invalid_runtime_maps(runtimes: object) -> None:
    assert selected_runtime_binding(runtimes) is None
