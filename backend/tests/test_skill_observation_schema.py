from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.runtime_observation import HostedRuntimeObservedSkillV1


@pytest.mark.parametrize("error_code", ["guard_blocked", "guard_confirmation_required"])
@pytest.mark.parametrize("status", ["installed", "removed", "failed", "unknown"])
def test_guard_reasons_require_failed_skill_observation(error_code: str, status: str) -> None:
    payload = {
        "skillKey": "skill-creator",
        "runtime": "hermes",
        "sourceIdentity": "a" * 64,
        "digest": "b" * 64,
        "sourceRevision": "c" * 64,
        "generation": 1,
        "desiredState": "absent" if status == "removed" else "present",
        "status": status,
        "errorCode": error_code,
    }
    if status == "failed":
        observed = HostedRuntimeObservedSkillV1.model_validate(payload)
        assert observed.model_dump(mode="json", by_alias=True)["errorCode"] == error_code
    else:
        with pytest.raises(ValidationError):
            HostedRuntimeObservedSkillV1.model_validate(payload)
