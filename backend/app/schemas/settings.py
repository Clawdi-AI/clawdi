from typing import Any, Literal

from pydantic import BaseModel, RootModel

# Fields that contain secrets and must be encrypted at rest.
SECRET_FIELDS: frozenset[str] = frozenset({"mem0_api_key"})


class UserSettingsData(BaseModel):
    """Typed representation of the user settings JSONB blob.

    All fields are optional so partial patches work without full replacement.
    Extend this model when new settings are introduced — avoids raw dicts
    scattered across the codebase and makes secret fields explicit.
    """

    memory_provider: str | None = None
    mem0_api_key: str | None = None
    mem0_org_id: str | None = None

    model_config = {"extra": "allow"}

    def extra_fields(self) -> dict[str, Any]:
        """Return fields that are not declared in the schema (extra allow)."""
        declared = set(self.model_fields)
        return {k: v for k, v in self.model_dump().items() if k not in declared}


class SettingsUpdate(BaseModel):
    settings: dict[str, Any]


class SettingsResponse(RootModel[dict[str, Any]]):
    pass


class SettingsUpdateResponse(BaseModel):
    status: Literal["updated"]
