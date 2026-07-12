import json
from io import StringIO
from uuid import uuid4

from scripts.audit_ai_provider_models import (
    ProviderModelRow,
    audit_provider_model_rows,
    write_report,
)


def test_audit_ai_provider_models_accepts_strict_valid_models() -> None:
    rows = [
        ProviderModelRow(
            id=uuid4(),
            provider_id="valid-provider",
            models=[
                {
                    "id": "gpt-test",
                    "label": "GPT Test",
                    "alias": "gpt-stable",
                    "api_mode": "openai_responses",
                    "input_modalities": ["text", "image", "video", "audio"],
                    "supports_vision": True,
                    "supports_tools": True,
                    "supports_reasoning": False,
                    "context_window": 128000,
                    "max_tokens": 16384,
                    "cost": {
                        "input": 1,
                        "output": 2,
                        "cache_read": 0.1,
                        "cache_write": 0.2,
                    },
                    "capabilities": {
                        "chat": True,
                        "responses": True,
                        "tools": True,
                        "vision": True,
                        "embeddings": False,
                        "image_generation": False,
                    },
                }
            ],
        )
    ]

    assert audit_provider_model_rows(rows) == []


def test_audit_ai_provider_models_rejects_invalid_models_without_echoing_values() -> None:
    row_id = uuid4()
    invalid_shape_row_id = uuid4()
    secret_like_value = "must-not-be-printed"
    findings = audit_provider_model_rows(
        [
            ProviderModelRow(
                id=row_id,
                provider_id="invalid-provider",
                models=[
                    {
                        "id": "gpt-test",
                        "context_window": 0,
                        "capabilities": {"chat": secret_like_value, "audio": True},
                        "cost": {"input": 1, "output": 2, "currency": "USD"},
                    }
                ],
            ),
            ProviderModelRow(
                id=invalid_shape_row_id,
                provider_id="invalid-shape-provider",
                models={},
            ),
        ]
    )
    output = StringIO()

    assert write_report(findings, output) == 1
    report = output.getvalue()
    assert str(row_id) in report
    assert str(invalid_shape_row_id) in report
    assert "invalid-provider" in report
    assert "invalid-shape-provider" in report
    assert "context_window" in report
    assert "capabilities.chat" in report
    assert "capabilities.audio" in report
    assert "cost.currency" in report
    assert secret_like_value not in report
    assert json.loads(report.splitlines()[-1]) == {"invalid_count": 2}


def test_audit_ai_provider_models_accepts_none_and_empty_models() -> None:
    rows = [
        ProviderModelRow(id=uuid4(), provider_id="none-models", models=None),
        ProviderModelRow(id=uuid4(), provider_id="empty-models", models=[]),
    ]
    output = StringIO()

    assert audit_provider_model_rows(rows) == []
    assert write_report([], output) == 0
    assert output.getvalue() == '{"invalid_count": 0}\n'
