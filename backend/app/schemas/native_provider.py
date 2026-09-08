"""Credential routing only; native runtimes own provider model catalogs."""

from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, TypeAdapter


class NativeRuntimeProvider(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str
    plugin: str | None = None
    package: str | None = None
    companion_plugin: str | None = None
    companion_package: str | None = None
    env: str | None = None
    base_url_env: str | None = None
    type: str | None = None
    base_url: str | None = None
    api_mode: str | None = None


class NativeProvider(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    variant: str | None
    type: str
    base_url: str
    api_mode: str
    runtime_env_name: str
    openclaw: NativeRuntimeProvider
    hermes: NativeRuntimeProvider


@lru_cache(maxsize=1)
def native_providers() -> list[NativeProvider]:
    path = (
        Path(__file__).resolve().parents[3]
        / "packages"
        / "shared"
        / "src"
        / "native-ai-providers.json"
    )
    return TypeAdapter(list[NativeProvider]).validate_json(path.read_bytes())


def native_provider(identity: str | None, variant: str | None = None) -> NativeProvider:
    candidates = [entry for entry in native_providers() if entry.id == identity]
    if variant is None and candidates:
        return candidates[0]
    for entry in candidates:
        if entry.variant == variant:
            return entry
    raise ValueError("Unknown native provider or variant")
