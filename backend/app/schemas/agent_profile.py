import uuid
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

ProfileKey = Annotated[
    str, StringConstraints(max_length=64, pattern=r"^([a-z0-9][a-z0-9_-]{0,63})?$")
]
UpstreamProfileKey = Annotated[
    str, StringConstraints(max_length=64, pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
]


class ProfileInventoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    upstream_key: UpstreamProfileKey
    is_default: bool


class ProfileInventoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    complete: bool
    profiles: list[ProfileInventoryItem] = Field(max_length=1000)

    @model_validator(mode="after")
    def unique_keys(self) -> Self:
        if len({p.upstream_key for p in self.profiles}) != len(self.profiles):
            raise ValueError("Profile upstream keys must be unique")
        if sum(p.is_default for p in self.profiles) > 1:
            raise ValueError("Only one default profile is allowed")
        return self


class AgentProfileResponse(BaseModel):
    id: uuid.UUID
    profile_key: str
    is_default: bool
    state: Literal["active", "removed"]
    session_count: int


class AttributeSessionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    local_session_ids: list[
        Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,199}$")]
    ] = Field(max_length=1000)


class ProfileRenameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    new_upstream_key: UpstreamProfileKey


class ProfileSessionMoveResponse(BaseModel):
    sessions_moved: int
    suppressions_moved: int
