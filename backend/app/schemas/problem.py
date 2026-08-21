from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

ACCOUNT_SUSPENDED_PROBLEM_CODE = "account_suspended"
ACCOUNT_SUSPENDED_PROBLEM_TYPE = "urn:clawdi:problem:account-suspended"
ACCOUNT_SUSPENDED_DETAIL = "Account is suspended"


class AccountSuspendedProblem(BaseModel):
    """Stable public auth rejection for a suspended account."""

    type: Literal["urn:clawdi:problem:account-suspended"] = ACCOUNT_SUSPENDED_PROBLEM_TYPE
    title: Literal["Account suspended"] = "Account suspended"
    status: Literal[401] = 401
    detail: Literal["Account is suspended"] = ACCOUNT_SUSPENDED_DETAIL
    code: Literal["account_suspended"] = ACCOUNT_SUSPENDED_PROBLEM_CODE
