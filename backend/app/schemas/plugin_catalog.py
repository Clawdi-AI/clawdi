from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator

AGENT_PLUGINS_SCHEMA_1_0_0 = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
TRUSTED_PLUGIN_REPOSITORY_URL = "https://github.com/Clawdi-AI/store"
TRUSTED_PLUGIN_CATALOG_PATH = "v2/catalog.json"
TRUSTED_PLUGIN_CATALOG_BRANCH = "main"

_PLUGIN_NAME_PATTERN = re.compile(r"^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
_SEMVER_CORE = r"(?:0|[1-9][0-9]*)"
_SEMVER_PRE = r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
EXACT_SEMVER_PATTERN = re.compile(
    rf"^{_SEMVER_CORE}\.{_SEMVER_CORE}\.{_SEMVER_CORE}"
    rf"(?:-{_SEMVER_PRE}(?:\.{_SEMVER_PRE})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_CATEGORY_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
_LANGUAGE_PATTERN = re.compile(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$")
_CONTROL_CHARACTER_PATTERN = re.compile(r"[\x00-\x1f\x7f]")


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def _validate_plugin_name(value: str) -> str:
    if _PLUGIN_NAME_PATTERN.fullmatch(value) is None:
        raise ValueError("name must be a canonical Agent Plugin name")
    return value


PluginName = Annotated[
    str,
    Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9.-]{0,63}$"),
    AfterValidator(_validate_plugin_name),
]


class CatalogComponents(_StrictModel):
    skills: list[str] = Field(max_length=1000)
    mcpServers: dict[
        str,
        Literal["stdio", "streamable-http", "sse"],
    ] = Field(max_length=1000)

    @field_validator("skills")
    @classmethod
    def _validate_skills(cls, value: list[str]) -> list[str]:
        if any(
            not name or len(name) > 64 or _CONTROL_CHARACTER_PATTERN.search(name) is not None
            for name in value
        ):
            raise ValueError("skill names must be bounded and contain no control characters")
        folded = [name.casefold() for name in value]
        if len(folded) != len(set(folded)):
            raise ValueError("skill names must not contain case-folded duplicates")
        return value

    @field_validator("mcpServers")
    @classmethod
    def _validate_mcp_servers(
        cls,
        value: dict[str, Literal["stdio", "streamable-http", "sse"]],
    ) -> dict[str, Literal["stdio", "streamable-http", "sse"]]:
        if any(
            not name or len(name) > 256 or _CONTROL_CHARACTER_PATTERN.search(name) is not None
            for name in value
        ):
            raise ValueError("MCP server names must be bounded and contain no control characters")
        return value

    @model_validator(mode="after")
    def _validate_not_empty(self) -> CatalogComponents:
        if not self.skills and not self.mcpServers:
            raise ValueError("components must contain at least one component")
        return self


class PluginCatalogDocumentEntry(_StrictModel):
    name: PluginName
    version: str = Field(min_length=1, max_length=256)
    displayName: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, min_length=1, max_length=512)
    publisher: str | None = Field(default=None, min_length=1, max_length=80)
    category: str = Field(min_length=1, max_length=64)
    keywords: list[str] = Field(max_length=20)
    languages: list[str] = Field(max_length=20)
    runtimes: list[Literal["openclaw", "hermes"]] = Field(max_length=2)
    hasConfiguration: bool
    components: CatalogComponents
    icon: str | None = Field(default=None, min_length=1, max_length=1024)
    path: str = Field(min_length=1, max_length=500)
    digest: str = Field(pattern=r"^sha256-tree-v1:[0-9a-f]{64}$")

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str) -> str:
        if EXACT_SEMVER_PATTERN.fullmatch(value) is None:
            raise ValueError("version must be an exact SemVer")
        return value

    @field_validator("description", "publisher", "icon", mode="before")
    @classmethod
    def _reject_explicit_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("optional catalog strings must be omitted rather than null")
        return value

    @field_validator("displayName", "description", "publisher", "category", "icon")
    @classmethod
    def _validate_text(cls, value: str | None) -> str | None:
        if value is not None and _CONTROL_CHARACTER_PATTERN.search(value) is not None:
            raise ValueError("catalog text must not contain control characters")
        return value

    @field_validator("category")
    @classmethod
    def _validate_category(cls, value: str) -> str:
        if _CATEGORY_PATTERN.fullmatch(value) is None:
            raise ValueError("category must be a lowercase slug")
        return value

    @field_validator("keywords", "languages", "runtimes")
    @classmethod
    def _validate_string_array(cls, value: list[str]) -> list[str]:
        if any(
            not item or len(item) > 64 or _CONTROL_CHARACTER_PATTERN.search(item) is not None
            for item in value
        ):
            raise ValueError("catalog arrays must contain bounded printable strings")
        folded = [item.casefold() for item in value]
        if len(folded) != len(set(folded)):
            raise ValueError("catalog arrays must not contain case-folded duplicates")
        return value

    @field_validator("keywords")
    @classmethod
    def _validate_keywords(cls, value: list[str]) -> list[str]:
        if any(len(item) > 32 for item in value):
            raise ValueError("keywords must not exceed 32 characters")
        return value

    @field_validator("languages")
    @classmethod
    def _validate_languages(cls, value: list[str]) -> list[str]:
        if any(_LANGUAGE_PATTERN.fullmatch(item) is None for item in value):
            raise ValueError("languages must contain canonical language tags")
        return value

    @model_validator(mode="after")
    def _validate_paths(self) -> PluginCatalogDocumentEntry:
        if self.path != f"./plugins/{self.name}":
            raise ValueError("path must equal ./plugins/<name>")
        if self.icon is not None:
            prefix = f"{self.path}/"
            suffix = self.icon.removeprefix(prefix)
            if (
                not self.icon.startswith(prefix)
                or not suffix
                or "\\" in suffix
                or any(segment in {"", ".", ".."} for segment in suffix.split("/"))
            ):
                raise ValueError("icon must remain within its plugin path")
        return self


class PluginCatalogDocument(_StrictModel):
    schemaVersion: Literal[1]
    plugins: list[PluginCatalogDocumentEntry] = Field(max_length=10_000)

    @model_validator(mode="after")
    def _validate_unique_entries(self) -> PluginCatalogDocument:
        names = [entry.name for entry in self.plugins]
        if len(names) != len(set(names)):
            raise ValueError("plugins must not contain duplicate names")
        if names != sorted(names, key=lambda name: name.encode("utf-8")):
            raise ValueError("plugins must be sorted by UTF-8 bytes of name")
        return self


class PluginCatalogEntryResponse(_StrictModel):
    name: str
    version: str
    display_name: str
    description: str | None = None
    publisher: str | None = None
    category: str
    keywords: list[str]
    languages: list[str]
    runtimes: list[Literal["openclaw", "hermes"]]
    icon: str | None = None
    components: CatalogComponents
    installable: bool
    installability_reason: (
        Literal[
            "configuration_not_supported",
            "no_supported_runtime",
        ]
        | None
    ) = None


class PluginCatalogResponse(_StrictModel):
    revision: str = Field(pattern=r"^[0-9a-f]{40}$")
    synced_at: datetime
    plugins: list[PluginCatalogEntryResponse]


class AgentPluginInstallRequest(_StrictModel):
    version: str | None = Field(default=None, min_length=1, max_length=256)

    @field_validator("version")
    @classmethod
    def _validate_version(cls, value: str | None) -> str | None:
        if value is not None and EXACT_SEMVER_PATTERN.fullmatch(value) is None:
            raise ValueError("version must be an exact catalog SemVer")
        return value


class AgentPluginDesiredStateResponse(_StrictModel):
    installation_id: UUID
    agent_id: UUID
    plugin_name: str
    version: str
    catalog_revision: str = Field(pattern=r"^[0-9a-f]{40}$")
    desired_state: Literal["present"] = "present"
    convergence: Literal["not_observed"] = "not_observed"
    created_at: datetime
    updated_at: datetime


class AgentPluginDesiredStateListResponse(_StrictModel):
    plugins: list[AgentPluginDesiredStateResponse]


class AgentPluginDesiredStateDeleteResponse(_StrictModel):
    agent_id: UUID
    plugin_name: str
    desired_state: Literal["absent"] = "absent"
    convergence: Literal["not_observed"] = "not_observed"


def catalog_source_path(entry: PluginCatalogDocumentEntry) -> str:
    """Resolve a generated v2 catalog-relative path to its repository path."""
    return f"v2/{entry.path.removeprefix('./')}"


def parse_catalog_document(payload: bytes) -> PluginCatalogDocument:
    """Decode strict JSON while rejecting duplicate keys before validation."""

    def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"duplicate catalog key: {key}")
            value[key] = item
        return value

    decoded = json.loads(payload.decode("utf-8"), object_pairs_hook=_object)
    return PluginCatalogDocument.model_validate(decoded)
