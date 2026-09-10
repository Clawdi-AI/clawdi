from typing import Literal

from pydantic import BaseModel, JsonValue, RootModel

# Fields that contain secrets and must be encrypted at rest.
SECRET_FIELDS: frozenset[str] = frozenset({"mem0_api_key"})


class SettingsUpdate(BaseModel):
    settings: dict[str, JsonValue]


class SettingsResponse(RootModel[dict[str, JsonValue]]):
    pass


class SettingsUpdateResponse(BaseModel):
    status: Literal["updated"]
