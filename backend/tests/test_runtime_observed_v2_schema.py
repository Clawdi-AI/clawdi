from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from app.routes.sessions import _runtime_observed_columns
from app.schemas.runtime_observed import HostedRuntimeObserved, HostedRuntimeObservedV2


def _payload() -> dict:
    return {
        "schemaVersion": "clawdi.hostedRuntimeObserved.v2",
        "reportedAt": "2026-07-13T00:00:00Z",
        "runtimeMode": "hosted",
        "status": "ok",
        "activeCliVersion": "1.2.3",
        "applied": {
            "etag": '"bundle"',
            "sourceRevision": "a" * 64,
            "generation": 3,
            "instanceId": "instance",
            "appliedProviderIds": ["provider"],
        },
        "boot": None,
        "cli": None,
    }


def test_runtime_observed_v2_is_strict_and_applied_is_complete() -> None:
    adapter = TypeAdapter(HostedRuntimeObserved)
    assert isinstance(adapter.validate_python(_payload()), HostedRuntimeObservedV2)

    partial = _payload()
    del partial["applied"]["sourceRevision"]
    with pytest.raises(ValidationError):
        adapter.validate_python(partial)

    extra = _payload()
    extra["channels"] = {"etag": '"legacy"'}
    with pytest.raises(ValidationError):
        adapter.validate_python(extra)

    projected = _payload()
    projected["applied"]["projectedProviderIds"] = ["target-specific"]
    with pytest.raises(ValidationError):
        adapter.validate_python(projected)


def test_runtime_observed_v2_columns_come_from_applied_authority() -> None:
    value = TypeAdapter(HostedRuntimeObserved).validate_python(_payload())
    assert isinstance(value, HostedRuntimeObservedV2)
    columns = _runtime_observed_columns(
        value,
        observed_at=value.reported_at,
    )
    assert columns["observed_config_generation"] == 3
    assert columns["observed_manifest_etag"] == '"bundle"'
    assert columns["observed_source_revision"] == "a" * 64
