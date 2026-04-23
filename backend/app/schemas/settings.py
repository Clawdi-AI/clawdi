from typing import Any, Literal

from pydantic import BaseModel, RootModel


class SettingsUpdate(BaseModel):
    settings: dict[str, Any]


class SettingsResponse(RootModel[dict[str, Any]]):
    pass


class SettingsUpdateResponse(BaseModel):
    status: Literal["updated"]
