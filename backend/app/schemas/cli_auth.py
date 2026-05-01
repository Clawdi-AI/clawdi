from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class DeviceStartRequest(BaseModel):
    # Display label like "Claude Code · kingsley-mbp" so the user knows what
    # they're authorizing. Optional; backend tolerates None.
    client_label: str | None = None


class DeviceStartResponse(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    expires_in: int
    interval: int


class DevicePollRequest(BaseModel):
    # Server-issued device_code is `secrets.token_urlsafe(32)` = 43
    # chars. Cap inbound at 128 so an unauthenticated /poll caller
    # can't push gigabytes of unique large strings through to the
    # process-wide rate-limit dict, where they'd get retained
    # within the 90/min IP cap and spike resident memory. Bad
    # codes reject at request-validation time (422) and never
    # reach the limiter or DB.
    device_code: str = Field(min_length=1, max_length=128)


# `pending` keeps polling. `approved` carries the api_key (one-shot). The
# explicit terminal states let the CLI print actionable copy without inferring
# from a generic 410.
DevicePollStatus = Literal["pending", "approved", "denied", "expired"]


class DevicePollResponse(BaseModel):
    status: DevicePollStatus
    api_key: str | None = None


class DeviceLookupResponse(BaseModel):
    user_code: str
    client_label: str | None
    status: str
    expires_at: datetime


class DeviceApproveRequest(BaseModel):
    user_code: str


class DeviceDenyRequest(BaseModel):
    user_code: str


class DeviceTerminalResponse(BaseModel):
    status: Literal["approved", "denied"]
