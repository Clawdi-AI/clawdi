from __future__ import annotations

import uuid

import pytest

from app.models.runtime_observation import V2RuntimeEnvironmentFence
from app.services.runtime_state_cleanup import validate_runtime_state_cleanup_receipt


def test_persisted_runtime_state_cleanup_receipt_fails_closed() -> None:
    environment_id = uuid.uuid4()
    cleanup_id = "cleanup-receipt-validation"
    fence = V2RuntimeEnvironmentFence(
        environment_id=environment_id,
        owner_id=uuid.uuid4(),
        deployment_id="deployment-receipt-validation",
        state="retired",
        retirement_id="retirement-receipt-validation",
        runtime_state_cleanup_id=cleanup_id,
        runtime_state_cleanup_receipt={
            "schemaVersion": "wrong",
            "environmentReference": str(environment_id),
            "expectedDeploymentBinding": "deployment-receipt-validation",
            "retirementId": "retirement-receipt-validation",
            "cleanupId": cleanup_id,
            "runtimeStateStatus": "already_absent",
            "cleanedAt": "not-a-timestamp",
        },
    )
    with pytest.raises(RuntimeError, match="receipt is invalid"):
        validate_runtime_state_cleanup_receipt(fence, cleanup_id=cleanup_id)

    fence.runtime_state_cleanup_receipt = {
        "schemaVersion": "clawdi.runtimeStateCleanupReceipt.v1",
        "environmentReference": str(environment_id),
        "expectedDeploymentBinding": fence.deployment_id,
        "retirementId": fence.retirement_id,
        "cleanupId": cleanup_id,
        "runtimeStateStatus": "absent",
        "cleanedAt": "2026-08-13T00:00:00",
    }
    with pytest.raises(RuntimeError, match="receipt is invalid"):
        validate_runtime_state_cleanup_receipt(fence, cleanup_id=cleanup_id)

    fence.runtime_state_cleanup_receipt = {
        "schemaVersion": "clawdi.runtimeStateCleanupReceipt.v1",
        "environmentReference": str(uuid.uuid4()),
        "expectedDeploymentBinding": fence.deployment_id,
        "retirementId": fence.retirement_id,
        "cleanupId": cleanup_id,
        "runtimeStateStatus": "absent",
        "cleanedAt": "2026-08-13T00:00:00Z",
    }
    with pytest.raises(RuntimeError, match="receipt identity is invalid"):
        validate_runtime_state_cleanup_receipt(fence, cleanup_id=cleanup_id)
