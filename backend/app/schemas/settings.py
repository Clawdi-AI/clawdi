from typing import Literal

from pydantic import BaseModel, JsonValue, RootModel, field_validator

# Fields that contain secrets and must be encrypted at rest.
SECRET_FIELDS: frozenset[str] = frozenset({"mem0_api_key"})


class SettingsUpdate(BaseModel):
    settings: dict[str, JsonValue]

    @field_validator("settings")
    @classmethod
    def validate_deploy_channel(cls, value: dict[str, JsonValue]) -> dict[str, JsonValue]:
        if "deploy_channel" in value and value["deploy_channel"] not in (None, "sui"):
            raise ValueError("deploy_channel must be sui or null")
        return value


class SettingsResponse(RootModel[dict[str, JsonValue]]):
    pass


class SettingsUpdateResponse(BaseModel):
    status: Literal["updated"]
