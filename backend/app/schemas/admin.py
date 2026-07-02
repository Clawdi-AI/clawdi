"""Schemas for admin endpoints (`/api/admin/*`).

These run behind the `X-Admin-Key` header gate (require_admin_api_key)
and are used by SaaS batch tooling + ops-side scripts. Kept in a
separate file so they don't pollute user-facing schemas.
"""

import re
from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

AdminChannelProvider = Literal["telegram", "discord", "whatsapp", "imessage"]
AdminChannelVisibility = Literal["private", "public"]
AdminChannelStatus = Literal["active", "disabled"]
_SUPPORTED_HOSTED_RUNTIMES = {"codex", "hermes", "openclaw"}
_RUNTIME_TARGET_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_BRIDGE_SURFACE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_HTTP_HEADER_NAME_RE = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SENSITIVE_UPSTREAM_HEADER_NAMES = {"authorization", "cookie", "proxy-authorization", "x-api-key"}
_RUNTIME_EXECUTION_KEYS = {
    "mode",
    "home",
    "stateDir",
    "workspace",
    "controlCommand",
    "versionCommand",
    "mcp",
    "terminal",
}
_RUNTIME_METADATA_KEYS = {
    "type",
    "enabled",
    "displayName",
    "environmentId",
    "providerId",
    "provider_id",
    "model",
    "primary_model",
    "image",
    "version",
    "updateChannel",
    "install",
    "run",
    "paths",
    "execution",
}
_RUNTIME_PATH_KEYS = {"home", "stateDir", "workspace"}
_RUNTIME_CONTROL_COMMAND_KEYS = {"command", "args", "env", "cwd"}
_RUNTIME_MCP_KEYS = {"source", "url", "transport"}
_RUNTIME_TERMINAL_KEYS = {"container", "user", "cwd", "env"}
_RUNTIME_IMAGE_KEYS = {"ref", "repository", "tag", "digest", "pullPolicy"}
_RUNTIME_VERSION_KEYS = {
    "desired",
    "observed",
    "observedAt",
    "upgradeAvailable",
    "upgradePolicy",
}
_BRIDGE_SURFACE_KEYS = {
    "name",
    "kind",
    "listenHost",
    "listenPort",
    "upstreamHost",
    "upstreamPort",
    "upstreamHeaders",
    "upstreamHeaderEnv",
}
_LIVE_SYNC_KEYS = {"enabled", "agents"}
_LIVE_SYNC_AGENT_KEYS = {"agentType", "agentId", "environmentId"}


def _validate_runtime_paths(runtime_name: str, value: Any) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"runtime {runtime_name}.paths must be an object")
    unknown = sorted(set(value) - _RUNTIME_PATH_KEYS)
    if unknown:
        raise ValueError(
            f"runtime {runtime_name}.paths has unsupported fields: {', '.join(unknown)}"
        )
    for field in _RUNTIME_PATH_KEYS:
        path = value.get(field)
        if path is not None:
            _require_absolute_path(f"runtime {runtime_name}.paths.{field}", path)


def _runtime_target_entries(
    runtimes: dict[str, Any],
    runtime_targets: dict[str, Any],
) -> list[tuple[str, str, dict[str, Any]]]:
    entries: dict[str, tuple[str, str, dict[str, Any]]] = {}
    for name, runtime in runtimes.items():
        if not isinstance(runtime, dict):
            continue
        runtime_type = runtime.get("type")
        if isinstance(runtime_type, str):
            entries[name] = (name, runtime_type, runtime)
    for target_id, runtime in runtime_targets.items():
        if not isinstance(runtime, dict):
            continue
        runtime_type = runtime.get("type")
        if isinstance(runtime_type, str):
            entries[target_id] = (target_id, runtime_type, runtime)
    return sorted(entries.values(), key=lambda item: item[0])


def _validate_runtime_entry(runtime_name: str, runtime: Any, *, require_type: bool = False) -> None:
    if not isinstance(runtime, dict):
        raise ValueError(f"runtime {runtime_name} desired state must be an object")
    unknown = sorted(set(runtime) - _RUNTIME_METADATA_KEYS)
    if unknown:
        raise ValueError(f"runtime {runtime_name} has unsupported fields: {', '.join(unknown)}")
    runtime_type = runtime.get("type")
    if require_type and runtime_type is None:
        raise ValueError(f"runtime {runtime_name}.type is required")
    if runtime_type is not None and runtime_type not in _SUPPORTED_HOSTED_RUNTIMES:
        raise ValueError(f"runtime {runtime_name}.type is unsupported")
    enabled = runtime.get("enabled")
    if not isinstance(enabled, bool):
        raise ValueError(f"runtime {runtime_name}.enabled must be a boolean")
    for field in ("displayName", "environmentId", "updateChannel"):
        text = runtime.get(field)
        if text is not None and (not isinstance(text, str) or not text.strip()):
            raise ValueError(f"runtime {runtime_name}.{field} must be a non-empty string")
    _validate_runtime_provider_binding(runtime_name, runtime)
    _validate_runtime_image(runtime_name, runtime.get("image"))
    _validate_runtime_version(runtime_name, runtime.get("version"))


def _validate_runtime_provider_binding(runtime_name: str, runtime: dict[str, Any]) -> None:
    for field in ("providerId", "provider_id", "model", "primary_model"):
        text = runtime.get(field)
        if text is not None and (not isinstance(text, str) or not text.strip()):
            raise ValueError(f"runtime {runtime_name}.{field} must be a non-empty string")
    _reject_conflicting_runtime_aliases(runtime_name, runtime, "providerId", "provider_id")
    _reject_conflicting_runtime_aliases(runtime_name, runtime, "model", "primary_model")


def _reject_conflicting_runtime_aliases(
    runtime_name: str,
    runtime: dict[str, Any],
    canonical: str,
    legacy: str,
) -> None:
    left = runtime.get(canonical)
    right = runtime.get(legacy)
    if left is None or right is None:
        return
    if str(left).strip() != str(right).strip():
        raise ValueError(
            f"runtime {runtime_name}.{canonical} conflicts with runtime {runtime_name}.{legacy}"
        )


def _validate_runtime_image(runtime_name: str, value: Any) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"runtime {runtime_name}.image must be an object")
    unknown = sorted(set(value) - _RUNTIME_IMAGE_KEYS)
    if unknown:
        raise ValueError(
            f"runtime {runtime_name}.image has unsupported fields: {', '.join(unknown)}"
        )
    for field in ("ref", "repository", "tag", "digest"):
        text = value.get(field)
        if text is not None and (not isinstance(text, str) or not text.strip()):
            raise ValueError(f"runtime {runtime_name}.image.{field} must be a non-empty string")
    pull_policy = value.get("pullPolicy")
    if pull_policy is not None and pull_policy not in {"IfNotPresent", "Always", "Never"}:
        raise ValueError(f"runtime {runtime_name}.image.pullPolicy is unsupported")


def _validate_runtime_version(runtime_name: str, value: Any) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"runtime {runtime_name}.version must be an object")
    unknown = sorted(set(value) - _RUNTIME_VERSION_KEYS)
    if unknown:
        raise ValueError(
            f"runtime {runtime_name}.version has unsupported fields: {', '.join(unknown)}"
        )
    for field in ("desired", "observed", "observedAt"):
        text = value.get(field)
        if text is not None and (not isinstance(text, str) or not text.strip()):
            raise ValueError(f"runtime {runtime_name}.version.{field} must be a non-empty string")
    upgrade_available = value.get("upgradeAvailable")
    if upgrade_available is not None and not isinstance(upgrade_available, bool):
        raise ValueError(f"runtime {runtime_name}.version.upgradeAvailable must be a boolean")
    upgrade_policy = value.get("upgradePolicy")
    if upgrade_policy is not None and upgrade_policy not in {"pinned", "track-channel", "manual"}:
        raise ValueError(f"runtime {runtime_name}.version.upgradePolicy is unsupported")


def _validate_runtime_execution(runtime_name: str, value: Any) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"runtime {runtime_name}.execution must be an object")
    unknown = sorted(set(value) - _RUNTIME_EXECUTION_KEYS)
    if unknown:
        raise ValueError(
            f"runtime {runtime_name}.execution has unsupported fields: {', '.join(unknown)}"
        )
    mode = value.get("mode", "managed-process")
    if mode not in {"managed-process", "external"}:
        raise ValueError(
            f"runtime {runtime_name}.execution.mode must be managed-process or external"
        )
    for field in ("home", "stateDir", "workspace"):
        path = value.get(field)
        if path is not None:
            _require_absolute_path(f"runtime {runtime_name}.execution.{field}", path)
    _validate_runtime_control_command(runtime_name, value.get("controlCommand"), "controlCommand")
    _validate_runtime_control_command(runtime_name, value.get("versionCommand"), "versionCommand")
    _validate_runtime_mcp(runtime_name, value.get("mcp"))
    _validate_runtime_terminal(runtime_name, value.get("terminal"))


def _validate_runtime_control_command(runtime_name: str, value: Any, field_name: str) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"runtime {runtime_name}.execution.{field_name} must be an object")
    unknown = sorted(set(value) - _RUNTIME_CONTROL_COMMAND_KEYS)
    if unknown:
        raise ValueError(
            f"runtime {runtime_name}.execution.{field_name} has unsupported fields: "
            f"{', '.join(unknown)}"
        )
    command = value.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ValueError(f"runtime {runtime_name}.execution.{field_name}.command is required")
    args = value.get("args", [])
    if not isinstance(args, list) or any(not isinstance(item, str) for item in args):
        raise ValueError(f"runtime {runtime_name}.execution.{field_name}.args must be strings")
    env = value.get("env", {})
    _validate_env_map(f"runtime {runtime_name}.execution.{field_name}.env", env)
    cwd = value.get("cwd")
    if cwd is not None:
        _require_absolute_path(f"runtime {runtime_name}.execution.{field_name}.cwd", cwd)


def _validate_runtime_mcp(runtime_name: str, value: Any) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"runtime {runtime_name}.execution.mcp must be an object")
    unknown = sorted(set(value) - _RUNTIME_MCP_KEYS)
    if unknown:
        raise ValueError(
            f"runtime {runtime_name}.execution.mcp has unsupported fields: {', '.join(unknown)}"
        )
    source = value.get("source")
    if source is not None and source not in {"backend-direct", "sidecar-local"}:
        raise ValueError(
            f"runtime {runtime_name}.execution.mcp.source must be backend-direct or sidecar-local"
        )
    url = value.get("url")
    if url is not None:
        if not isinstance(url, str) or not url.strip():
            raise ValueError(f"runtime {runtime_name}.execution.mcp.url must be a URL")
        if source is None:
            raise ValueError(
                f"runtime {runtime_name}.execution.mcp.source is required when url is set"
            )
        if source == "sidecar-local" and not _is_plain_http_url(url):
            raise ValueError(
                f"runtime {runtime_name}.execution.mcp.url must be an http:// URL for sidecar-local"
            )
        if source == "backend-direct" and urlparse(url).scheme not in {"http", "https"}:
            raise ValueError(
                f"runtime {runtime_name}.execution.mcp.url must be an http:// or https:// URL"
            )
    if source == "sidecar-local" and url is None:
        raise ValueError(f"runtime {runtime_name}.execution.mcp.url is required for sidecar-local")
    transport = value.get("transport", "streamable-http")
    if transport != "streamable-http":
        raise ValueError(f"runtime {runtime_name}.execution.mcp.transport must be streamable-http")


def _validate_runtime_terminal(runtime_name: str, value: Any) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"runtime {runtime_name}.execution.terminal must be an object")
    unknown = sorted(set(value) - _RUNTIME_TERMINAL_KEYS)
    if unknown:
        raise ValueError(
            f"runtime {runtime_name}.execution.terminal has unsupported fields: "
            f"{', '.join(unknown)}"
        )
    for field in ("container", "user"):
        text = value.get(field)
        if text is not None and (not isinstance(text, str) or not text.strip()):
            raise ValueError(
                f"runtime {runtime_name}.execution.terminal.{field} must be a non-empty string"
            )
    cwd = value.get("cwd")
    if cwd is not None:
        _require_absolute_path(f"runtime {runtime_name}.execution.terminal.cwd", cwd)
    _validate_env_map(
        f"runtime {runtime_name}.execution.terminal.env",
        value.get("env", {}),
    )


def _validate_env_map(label: str, value: Any) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    for key, env_value in value.items():
        if not isinstance(key, str) or not _ENV_KEY_RE.fullmatch(key):
            raise ValueError(f"{label} has an invalid environment variable name")
        if not isinstance(env_value, str):
            raise ValueError(f"{label}.{key} must be a string")


def _require_absolute_path(label: str, value: Any) -> None:
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError(f"{label} must be an absolute path")


def _is_plain_http_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme == "http" and bool(parsed.netloc)


class AdminEnvironmentCreate(BaseModel):
    """Body for `POST /api/admin/environments`. Mirrors the
    user-facing EnvironmentCreate but takes target_clerk_id
    instead of relying on auth context to resolve the user.

    Idempotent — re-registering the same (user, machine_id) pair
    updates `machine_name` / `agent_version` / `last_seen_at` and
    returns the existing env id.
    """

    target_clerk_id: str
    machine_id: str
    machine_name: str
    agent_type: str
    agent_version: str | None = None
    os_name: str = "linux"


class AdminApiKeyCreate(BaseModel):
    """Body for `POST /api/admin/auth/keys` — mint an api_key on
    behalf of a user identified by Clerk id. The route resolves
    `target_clerk_id` to the internal `User.id` and then calls the
    existing `mint_api_key` service, preserving the env-ownership
    invariant the service enforces.

    `environment_id` is optional — if set, the minted key is bound
    to that env (deploy-key semantics). If null, the key is unbound.

    `scopes` is optional — same API-permission semantics as the user-facing
    `ApiKeyCreate`: `None` means full account access (the default
    for both user-self-mint and admin-mint). Pass an explicit list
    to narrow the minted key for ops tooling that doesn't need
    everything.
    """

    target_clerk_id: str
    label: str
    environment_id: str | None = None
    scopes: list[str] | None = None


class AdminRuntimeStateUpsert(BaseModel):
    """Hosted runtime desired state written by the SaaS deploy orchestrator.

    This is deployment-level state only. Native channel credentials and channel
    links are owned by `/api/channels/*` and must not be embedded here.
    """

    model_config = ConfigDict(extra="forbid")

    deployment_id: str = Field(min_length=1, max_length=200)
    app_id: str | None = Field(default=None, min_length=1, max_length=200)
    instance_id: str = Field(min_length=1, max_length=200)
    generation: int = Field(ge=0)
    provider_id: str | None = Field(default=None, min_length=2, max_length=80)
    system: dict[str, Any] | None = None
    control_plane: dict[str, Any] | None = None
    clawdi_cli: dict[str, Any] | None = None
    runtimes: dict[str, Any] = Field(default_factory=dict)
    runtime_targets: dict[str, Any] = Field(default_factory=dict)
    bridge: dict[str, Any] | None = None
    live_sync: dict[str, Any] | None = None
    recovery: dict[str, Any] | None = None
    mitm_profiles: dict[str, Any] | None = None
    mcp: dict[str, Any] | None = None
    tools: dict[str, Any] | None = None

    @field_validator("runtimes")
    @classmethod
    def _validate_runtimes(cls, value: dict[str, Any]) -> dict[str, Any]:
        if "channels" in value:
            raise ValueError("channels are not runtime desired state")
        for name, runtime in value.items():
            _validate_runtime_entry(name, runtime, require_type=True)
        return value

    @field_validator("runtime_targets")
    @classmethod
    def _validate_runtime_targets(cls, value: dict[str, Any]) -> dict[str, Any]:
        for target_id, runtime in value.items():
            if not isinstance(target_id, str) or not _RUNTIME_TARGET_ID_RE.fullmatch(target_id):
                raise ValueError("runtime target ids must be lowercase ids")
            _validate_runtime_entry(target_id, runtime, require_type=True)
        return value

    @model_validator(mode="after")
    def _validate_runtime_execution(self) -> "AdminRuntimeStateUpsert":
        targets = _runtime_target_entries(self.runtimes, self.runtime_targets)
        if not targets:
            raise ValueError("runtime desired state must declare runtimes or runtime_targets")
        for name, runtime_type, runtime in targets:
            _validate_runtime_paths(name, runtime.get("paths"))
            _validate_runtime_execution(name, runtime.get("execution"))
            self._validate_runtime_target_execution_semantics(name, runtime_type, runtime)
        self._validate_runtime_target_isolation(targets)
        return self

    @classmethod
    def _validate_runtime_target_execution_semantics(
        cls, target_id: str, runtime_type: str, runtime: dict[str, Any]
    ) -> None:
        execution = runtime.get("execution") if isinstance(runtime.get("execution"), dict) else {}
        mode = execution.get("mode", "managed-process")
        if mode != "external":
            return
        if runtime.get("install") is not None:
            raise ValueError(
                f"runtime {target_id} uses external execution and must not declare install metadata"
            )
        if runtime_type == "openclaw" and not execution.get("stateDir"):
            raise ValueError(f"runtime {target_id} external execution requires execution.stateDir")
        if runtime_type == "hermes" and not execution.get("home") and not execution.get("stateDir"):
            raise ValueError(
                f"runtime {target_id} external execution requires "
                "execution.home or execution.stateDir"
            )

    @classmethod
    def _validate_runtime_target_isolation(
        cls, targets: list[tuple[str, str, dict[str, Any]]]
    ) -> None:
        seen_state_paths: dict[str, str] = {}
        seen_terminal_containers: dict[str, str] = {}
        for target_id, runtime_type, runtime in targets:
            if runtime.get("enabled") is not True:
                continue
            execution = (
                runtime.get("execution") if isinstance(runtime.get("execution"), dict) else {}
            )
            mode = execution.get("mode", "managed-process")
            if mode == "external":
                state_path = execution.get("stateDir")
                if runtime_type == "hermes":
                    state_path = execution.get("home") or state_path
                if isinstance(state_path, str):
                    owner = seen_state_paths.get(state_path)
                    if owner and owner != target_id:
                        raise ValueError(
                            f"runtime targets {owner} and {target_id} share state path {state_path}"
                        )
                    seen_state_paths[state_path] = target_id
            terminal = (
                execution.get("terminal") if isinstance(execution.get("terminal"), dict) else {}
            )
            container = terminal.get("container")
            if isinstance(container, str) and container:
                owner = seen_terminal_containers.get(container)
                if owner and owner != target_id:
                    raise ValueError(
                        f"runtime targets {owner} and {target_id} share terminal "
                        f"container {container}"
                    )
                seen_terminal_containers[container] = target_id

    @field_validator("control_plane")
    @classmethod
    def _validate_control_plane(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None and "apiUrl" in value:
            raise ValueError("hosted runtime controlPlane must use cloudApiUrl")
        return value

    @field_validator("live_sync")
    @classmethod
    def _validate_live_sync(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        if not isinstance(value, dict):
            raise ValueError("live_sync must be an object")
        unknown = sorted(set(value) - _LIVE_SYNC_KEYS)
        if unknown:
            raise ValueError(f"live_sync has unsupported fields: {', '.join(unknown)}")
        enabled = value.get("enabled")
        if enabled is not None and not isinstance(enabled, bool):
            raise ValueError("live_sync.enabled must be a boolean")
        agents = value.get("agents", [])
        if not isinstance(agents, list):
            raise ValueError("live_sync.agents must be an array")
        for index, agent in enumerate(agents):
            if not isinstance(agent, dict):
                raise ValueError(f"live_sync.agents[{index}] must be an object")
            unknown_agent = sorted(set(agent) - _LIVE_SYNC_AGENT_KEYS)
            if unknown_agent:
                raise ValueError(
                    f"live_sync.agents[{index}] has unsupported fields: {', '.join(unknown_agent)}"
                )
            agent_type = agent.get("agentType")
            if agent_type not in _SUPPORTED_HOSTED_RUNTIMES:
                raise ValueError(f"live_sync.agents[{index}].agentType is unsupported")
            agent_id = agent.get("agentId")
            if not isinstance(agent_id, str) or not _RUNTIME_TARGET_ID_RE.fullmatch(agent_id):
                raise ValueError(f"live_sync.agents[{index}].agentId is required")
            environment_id = agent.get("environmentId")
            if not isinstance(environment_id, str) or not environment_id.strip():
                raise ValueError(f"live_sync.agents[{index}].environmentId is required")
        return value

    @field_validator("bridge")
    @classmethod
    def _validate_bridge(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        surfaces = value.get("surfaces")
        if set(value) != {"surfaces"} or not isinstance(surfaces, list):
            raise ValueError("bridge must contain only a surfaces array")
        for index, surface in enumerate(surfaces):
            if not isinstance(surface, dict):
                raise ValueError(f"bridge.surfaces[{index}] must be an object")
            unknown = sorted(set(surface) - _BRIDGE_SURFACE_KEYS)
            if unknown:
                raise ValueError(
                    f"bridge.surfaces[{index}] has unsupported fields: {', '.join(unknown)}"
                )
            name = surface.get("name")
            if not isinstance(name, str) or not _BRIDGE_SURFACE_NAME_RE.fullmatch(name):
                raise ValueError(f"bridge.surfaces[{index}].name must be a lowercase surface id")
            if surface.get("kind") != "control-ui":
                raise ValueError(f"bridge.surfaces[{index}].kind must be control-ui")
            for field in ("listenPort", "upstreamPort"):
                port = surface.get(field)
                if not isinstance(port, int) or isinstance(port, bool) or port < 1 or port > 65535:
                    raise ValueError(f"bridge.surfaces[{index}].{field} must be a TCP port")
            for field in ("listenHost", "upstreamHost"):
                host = surface.get(field)
                if host is not None and (not isinstance(host, str) or not host.strip()):
                    raise ValueError(f"bridge.surfaces[{index}].{field} must be a non-empty string")
            cls._validate_bridge_header_map(
                surface.get("upstreamHeaders"),
                index,
                "upstreamHeaders",
                _HTTP_HEADER_NAME_RE,
                reject_sensitive=True,
            )
            cls._validate_bridge_header_map(
                surface.get("upstreamHeaderEnv"),
                index,
                "upstreamHeaderEnv",
                _HTTP_HEADER_NAME_RE,
                value_re=_ENV_KEY_RE,
            )
            cls._validate_bridge_header_overlap(surface, index)
        return value

    @classmethod
    def _validate_bridge_header_overlap(cls, surface: dict[str, Any], surface_index: int) -> None:
        static_headers = surface.get("upstreamHeaders") or {}
        env_headers = surface.get("upstreamHeaderEnv") or {}
        if not isinstance(static_headers, dict) or not isinstance(env_headers, dict):
            return
        static_names = {name.lower() for name in static_headers if isinstance(name, str)}
        duplicates = sorted(
            name for name in env_headers if isinstance(name, str) and name.lower() in static_names
        )
        if duplicates:
            raise ValueError(
                f"bridge.surfaces[{surface_index}] has duplicate upstream header declarations: "
                f"{', '.join(duplicates)}"
            )

    @classmethod
    def _validate_bridge_header_map(
        cls,
        value: Any,
        surface_index: int,
        field: str,
        key_re: re.Pattern[str],
        *,
        value_re: re.Pattern[str] | None = None,
        reject_sensitive: bool = False,
    ) -> None:
        if value is None:
            return
        if not isinstance(value, dict):
            raise ValueError(f"bridge.surfaces[{surface_index}].{field} must be an object")
        for header_name, header_value in value.items():
            if not isinstance(header_name, str) or not key_re.fullmatch(header_name):
                raise ValueError(
                    f"bridge.surfaces[{surface_index}].{field} has an invalid header name"
                )
            if not isinstance(header_value, str):
                raise ValueError(
                    f"bridge.surfaces[{surface_index}].{field}.{header_name} must be a string"
                )
            if reject_sensitive and header_name.lower() in _SENSITIVE_UPSTREAM_HEADER_NAMES:
                raise ValueError(
                    f"bridge.surfaces[{surface_index}].{field}.{header_name} "
                    "must use upstreamHeaderEnv"
                )
            if value_re is not None and not value_re.fullmatch(header_value):
                raise ValueError(
                    f"bridge.surfaces[{surface_index}].{field}.{header_name} "
                    "must reference an environment variable"
                )

    @field_validator("mcp", "tools")
    @classmethod
    def _validate_tool_desired_state(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is not None:
            _reject_plaintext_tool_secret(value)
        return value


class AdminRuntimeStateResponse(BaseModel):
    environment_id: UUID
    deployment_id: str
    instance_id: str
    generation: int


class AdminManagedAiProviderUpsert(BaseModel):
    """Create or rotate the first-party managed AI provider for a user."""

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    target_clerk_id: str
    base_url: str = Field(min_length=1, max_length=1000)
    api_key: SecretStr = Field(min_length=1)
    default_model: str | None = Field(default=None, max_length=300)
    label: str | None = Field(default=None, max_length=200)
    capabilities: dict[str, Any] | None = None


class AdminManagedAiProviderResponse(BaseModel):
    owner_user_id: UUID
    owner_clerk_id: str
    provider_id: str
    api_mode: str
    runtime_env_name: str
    base_url: str
    default_model: str | None = None
    has_api_key: bool


class AdminChannelCreate(BaseModel):
    """Create a provider bot account through the admin control plane.

    `target_clerk_id` supplies the backing user row for bookkeeping and
    private managed bots. Public bots remain admin-managed shared
    infrastructure: authenticated users can create their own links and pair
    codes, but cannot mutate provider credentials or destructive bot-level
    state through user APIs.
    """

    target_clerk_id: str
    provider: AdminChannelProvider
    name: str = Field(min_length=1, max_length=120)
    visibility: AdminChannelVisibility = "public"
    provider_token: str | None = Field(default=None, min_length=1, max_length=2000)
    config: dict[str, Any] | None = None
    secrets: dict[str, str] | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("name cannot be blank")
        return stripped

    @field_validator("secrets")
    @classmethod
    def _validate_secrets(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        return _clean_channel_secret_values(value)


class AdminChannelUpdate(BaseModel):
    """Patch provider bot metadata and credentials.

    Omitted fields are left unchanged. Passing `provider_token: null` clears the
    provider token; passing `config: null` clears bot config.
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    status: AdminChannelStatus | None = None
    visibility: AdminChannelVisibility | None = None
    provider_token: str | None = Field(default=None, min_length=1, max_length=2000)
    config: dict[str, Any] | None = None
    secrets: dict[str, str] | None = None

    @field_validator("name")
    @classmethod
    def _strip_optional_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("name cannot be blank")
        return stripped

    @field_validator("secrets")
    @classmethod
    def _validate_secrets(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        return _clean_channel_secret_values(value)


class AdminChannelResponse(BaseModel):
    id: UUID
    owner_user_id: UUID
    owner_clerk_id: str
    provider: str
    name: str
    status: str
    visibility: AdminChannelVisibility
    has_provider_token: bool
    webhook_url: str
    config: dict[str, Any] | None = None
    archived_at: datetime | None = None
    created_at: datetime
    updated_at: datetime | None = None


class AdminChannelCreatedResponse(AdminChannelResponse):
    webhook_secret: str


class AdminChannelWebhookSecretResponse(BaseModel):
    id: UUID
    webhook_secret: str


def _clean_channel_secret_values(value: dict[str, str] | None) -> dict[str, str] | None:
    if value is None:
        return None
    cleaned: dict[str, str] = {}
    for key, secret in value.items():
        name = key.strip()
        if not name or len(name) > 80 or not name.replace("_", "").isalnum():
            raise ValueError("secret names must be alphanumeric or underscore")
        if not isinstance(secret, str) or not secret:
            raise ValueError("secret values cannot be blank")
        cleaned[name] = secret
    return cleaned


_FORBIDDEN_TOOL_SECRET_KEYS = {
    "apikey",
    "api_key",
    "authorization",
    "bearer",
    "header",
    "headers",
    "password",
    "secret",
    "secrets",
    "secretvalues",
    "token",
}


def _reject_plaintext_tool_secret(value: Any, path: str = "") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).replace("-", "_").lower()
            if normalized in _FORBIDDEN_TOOL_SECRET_KEYS:
                location = f" at {path}.{key}" if path else f" at {key}"
                raise ValueError(
                    f"mcp/tools desired state must not contain plaintext secrets{location}"
                )
            _reject_plaintext_tool_secret(child, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_plaintext_tool_secret(child, f"{path}[{index}]")
