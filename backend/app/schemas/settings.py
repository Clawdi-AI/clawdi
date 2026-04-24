from typing import Any, Literal

from pydantic import BaseModel, RootModel

# Fields that contain secrets and must be encrypted at rest.
SECRET_FIELDS: frozenset[str] = frozenset({"mem0_api_key"})


class SettingsUpdate(BaseModel):
    settings: dict[str, Any]


class SettingsResponse(RootModel[dict[str, Any]]):
    pass


class SettingsUpdateResponse(BaseModel):
    status: Literal["updated"]
