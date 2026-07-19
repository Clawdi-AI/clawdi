"""Local v2 deploy API mock for dashboard previews.

Run from ``backend/``:

    uv run python scripts/mock_deploy_api.py --host 0.0.0.0 --port 50001

This is intentionally in-memory and dev-only. It lets the web dashboard exercise
hosted/v2 UI flows without the external hosted runtime service.
"""

from __future__ import annotations

import argparse
import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

DEV_V2_DEPLOYMENT_ID = "hdep_dev_sidebar"
DEV_V2_APP_ID = "app_dev_sidebar"
DEV_V2_PROVIDER_ID = "openrouter-dev"
DEV_V2_MANAGED_PROVIDER_ID = "clawdi-v2"
STABLE_UUID_NAMESPACE = uuid.UUID("6a9575fd-7eb5-464a-89e7-e13f090f8de6")


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def _stable_uuid(clerk_id: str, label: str) -> str:
    return str(uuid.uuid5(STABLE_UUID_NAMESPACE, f"{clerk_id}:{label}"))


def _clerk_id() -> str:
    return os.getenv("DEV_AUTH_CLERK_ID", "user_dev_preview")


def _openclaw_env_id() -> str:
    return os.getenv("MOCK_OPENCLAW_ENV_ID") or _stable_uuid(_clerk_id(), "hosted-openclaw-env")


def _codex_env_id() -> str:
    return os.getenv("MOCK_CODEX_ENV_ID") or _stable_uuid(_clerk_id(), "hosted-codex-env")


def _hermes_env_id() -> str:
    return os.getenv("MOCK_HERMES_ENV_ID") or _stable_uuid(_clerk_id(), "hosted-hermes-env")


def _web_base_url() -> str:
    return os.getenv("MOCK_WEB_BASE_URL", "http://localhost:3001").rstrip("/")


def _ws_base_url(request: Request) -> str:
    base_url = str(request.base_url).rstrip("/")
    if base_url.startswith("https://"):
        return f"wss://{base_url[len('https://') :]}"
    if base_url.startswith("http://"):
        return f"ws://{base_url[len('http://') :]}"
    return base_url


def _runtime_env_id(agent_type: str) -> str:
    if agent_type == "codex":
        return _codex_env_id()
    if agent_type == "openclaw":
        return _openclaw_env_id()
    if agent_type == "hermes":
        return _hermes_env_id()
    raise HTTPException(status_code=400, detail="Unsupported runtime")


def _ordered_agents(values: set[str]) -> list[str]:
    order = {"codex": 0, "openclaw": 1, "hermes": 2}
    return sorted(values, key=lambda value: order.get(value, 99))


def _primary_model_value(raw: Any) -> str | None:
    if isinstance(raw, dict):
        model = raw.get("model")
        return model.strip() if isinstance(model, str) and model.strip() else None
    return raw.strip() if isinstance(raw, str) and raw.strip() else None


def _primary_provider_id(raw: Any) -> str | None:
    if isinstance(raw, dict):
        provider_id = raw.get("provider_id") or raw.get("providerId")
        return provider_id.strip() if isinstance(provider_id, str) and provider_id.strip() else None
    return None


def _primary_model_ref(provider_id: str, model: str) -> dict[str, str]:
    return {"provider_id": provider_id, "model": model}


def _provider_ids(body: dict[str, Any], primary_provider_id: str) -> list[str]:
    raw = body.get("provider_ids") or body.get("providerIds")
    if not isinstance(raw, list):
        return [primary_provider_id]
    provider_ids: list[str] = []
    for value in raw:
        if isinstance(value, str) and value.strip() and value.strip() not in provider_ids:
            provider_ids.append(value.strip())
    if primary_provider_id not in provider_ids:
        provider_ids.insert(0, primary_provider_id)
    return provider_ids or [primary_provider_id]


def _base_config() -> dict[str, Any]:
    return {
        "compute_plan_slug": "compute_performance",
        "mux_enabled": True,
        "telegram_mux_enabled": True,
        "discord_mux_enabled": False,
        "whatsapp_mux_enabled": False,
        "imessage_mux_enabled": False,
        "kobb_available": True,
        "channel": "telegram",
        "primary_model": "openai/gpt-4o-mini",
        "ai_provider_id": DEV_V2_PROVIDER_ID,
        "ai_provider_auth_kind": "api_key",
        "runtime": "openclaw",
        "ai_provider_bindings": {
            "codex": {
                "provider_id": DEV_V2_PROVIDER_ID,
                "provider_ids": [DEV_V2_PROVIDER_ID],
                "auth_kind": "api_key",
                "primary_model": _primary_model_ref(DEV_V2_PROVIDER_ID, "openai/gpt-4o-mini"),
            },
            "openclaw": {
                "provider_id": DEV_V2_PROVIDER_ID,
                "provider_ids": [DEV_V2_PROVIDER_ID],
                "auth_kind": "api_key",
                "primary_model": _primary_model_ref(DEV_V2_PROVIDER_ID, "openai/gpt-4o-mini"),
            },
            "hermes": {
                "provider_id": DEV_V2_PROVIDER_ID,
                "provider_ids": [DEV_V2_PROVIDER_ID],
                "auth_kind": "api_key",
                "primary_model": _primary_model_ref(DEV_V2_PROVIDER_ID, "openai/gpt-4o-mini"),
            },
        },
        "telegram_allowed_usernames": ["dev-user", "dev-preview"],
        "telegram_bot_username": "clawdi_dev_bot",
        "telegram_entry_url": "https://t.me/clawdi_dev_bot",
        "telegram_provider": "native",
        "public_ports": [18789, 9119],
        "enable_openclaw": True,
        "enable_hermes": True,
        "onboarded_agents": ["codex", "openclaw", "hermes"],
        "configured_agents": ["codex", "openclaw", "hermes"],
        "clawdi_cloud_environments": {
            "codex": _codex_env_id(),
            "openclaw": _openclaw_env_id(),
            "hermes": _hermes_env_id(),
        },
        "vcpu": 4,
        "ram_gb": 8,
        "disk_gb": 80,
    }


def _deployment(
    *,
    deployment_id: str = DEV_V2_DEPLOYMENT_ID,
    name: str = "dev-sidebar-preview",
    status: str = "running",
    config_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    created = _now() - timedelta(hours=3)
    return {
        "id": deployment_id,
        "user_id": "usr_dev_preview",
        "name": name,
        "app_id": DEV_V2_APP_ID,
        "backend": "mock",
        "status": status,
        "endpoints": [
            "https://codex.dev-preview.local",
            "https://openclaw.dev-preview.local",
            "https://hermes.dev-preview.local",
        ],
        "gateway_token": None,
        "openclaw_control_ui_url": "https://openclaw.dev-preview.local",
        "hermes_control_ui_url": "https://hermes.dev-preview.local",
        "config_info": config_info or _base_config(),
        "created_at": _iso(created),
        "upgrade_available": False,
        "agent_version": "v2-dev",
        "app_image": "clawdi/hosted-runtime:dev",
    }


def _summary_state(status: str) -> str:
    if status == "provisioning":
        return "creating"
    if status == "ready":
        return "running"
    if status in {
        "creating",
        "starting",
        "running",
        "stopping",
        "stopped",
        "restarting",
        "updating",
        "deleting",
        "deleted",
        "failed",
    }:
        return status
    raise ValueError(f"Unsupported mock deployment status: {status}")


def _read_provider_auth_kind(value: Any) -> str:
    if value in {"unmanaged", "managed", "api_key", "codex_oauth"}:
        return str(value)
    raise ValueError(f"Unsupported mock provider auth kind: {value!r}")


def _runtime_configuration(config: dict[str, Any], runtime: str) -> dict[str, Any]:
    binding = (config.get("ai_provider_bindings") or {}).get(runtime) or {}
    auth_kind = _read_provider_auth_kind(
        binding.get("auth_kind") or config.get("ai_provider_auth_kind")
    )
    if auth_kind == "unmanaged":
        return {"primary_model": None, "providers": [], "features": []}

    provider_id = binding.get("provider_id") or config.get("ai_provider_id")
    primary_model = binding.get("primary_model")
    providers = []
    if isinstance(provider_id, str) and provider_id:
        providers.append(
            {
                "provider_id": provider_id,
                "auth_kind": "managed" if auth_kind == "managed" else "secret_reference",
                "models": [],
            }
        )
    return {
        "primary_model": primary_model if isinstance(primary_model, dict) else None,
        "providers": providers,
        "features": [],
    }


def _funding_fact(record: dict[str, Any]) -> dict[str, Any] | None:
    event = record.get("last_funding_event")
    if not isinstance(event, dict):
        return None
    return {
        "fact_kind": "funding_revoked",
        "commercial_revision": 1,
        "compute_subscription_id": event.get("subscription_id"),
        "compute_plan_slug": None,
        "funding_source": event.get("funding_source"),
        "reason": event.get("reason"),
        "prior_plan_slug": event.get("prior_plan_slug"),
        "occurred_at": event.get("occurred_at"),
        "emitted_at": event.get("occurred_at"),
    }


def _deployment_read_response(record: dict[str, Any]) -> dict[str, Any]:
    config = record["config_info"]
    runtime = config.get("runtime")
    if runtime not in {"openclaw", "hermes"}:
        raise ValueError(f"Unsupported mock deployment runtime: {runtime!r}")
    summary_state = _summary_state(record["status"])
    backing_infra = "absent" if summary_state in {"stopped", "deleted"} else "present"
    binding = (config.get("ai_provider_bindings") or {}).get(runtime) or {}
    provider_auth_kind = _read_provider_auth_kind(
        binding.get("auth_kind") or config.get("ai_provider_auth_kind")
    )
    runtime_ui_url = (
        record.get("openclaw_control_ui_url")
        if runtime == "openclaw"
        else record.get("hermes_control_ui_url")
    )
    failure_reason = record.get("failure_reason")
    failure = (
        {
            "type": "https://api.clawdi.ai/problems/runtime-readiness-timeout",
            "title": failure_reason,
            "status": 504,
            "detail": "The runtime did not become ready before the startup deadline.",
            "instance": record["id"],
            "code": "runtime_readiness_timeout",
            "phase": "readiness",
            "retryable": True,
            "conditionReason": "RuntimeReadinessTimeout",
            "conditionMessage": failure_reason,
            "observedGeneration": 1,
        }
        if isinstance(failure_reason, str) and failure_reason
        else None
    )
    endpoints = [
        {"name": f"endpoint-{index}", "url": url}
        for index, url in enumerate(record.get("endpoints") or [], start=1)
    ]
    return {
        "resource": {
            "id": record["id"],
            "owner_user_id": record["user_id"],
            "commercial_revision": 1,
            "deployment_target": "saas",
            "metadata": {
                "generation": 1,
                "manifestETag": f"etag_{record['id']}",
                "resourceVersion": f"rv_{record['id']}",
                "createdAt": record["created_at"],
                "updatedAt": record["created_at"],
            },
            "spec": {
                "schema_version": 1,
                "desired_lifecycle": (
                    "stopped"
                    if summary_state == "stopped"
                    else "deleted"
                    if summary_state == "deleted"
                    else "running"
                ),
                "runtime": runtime,
                "runtime_version": "dev",
                "name": record["name"],
                "resources": {
                    "vcpu": config.get("vcpu", 1),
                    "memory_mib": config.get("ram_gb", 2) * 1024,
                    "disk_gib": config.get("disk_gb", 20),
                },
                "agents": [],
                "ports": [],
                "runtime_configuration": _runtime_configuration(config, runtime),
                "rollout_nonce": 0,
                "secret_references": [],
            },
            "status": {
                "summary_state": summary_state,
                "observedGeneration": 1,
                "conditions": [],
                "failure": failure,
                "backing_infrastructure": backing_infra,
                "driver_acknowledged_generation": 1,
                "driver_applied_generation": 1,
                "driver_observation_sequence": 1,
                "endpoints": endpoints,
            },
        },
        "clawdi_cloud_environments": config.get("clawdi_cloud_environments") or {},
        "ai_provider_auth_kinds": {runtime: provider_auth_kind},
        "runtime_ui_endpoint": (
            {
                "runtime": runtime,
                "role": "control_ui",
                "url": runtime_ui_url,
                "requires_bridge_token": True,
            }
            if isinstance(runtime_ui_url, str) and runtime_ui_url
            else None
        ),
        "accepted_operation": None,
        "commercial_display": {
            "compute_subscription": record.get("compute_subscription"),
            "latest_funding_fact": _funding_fact(record),
        },
        "current_plan_slug": config["compute_plan_slug"],
        "upgrade_available": record.get("upgrade_available", False),
        "compute_slot_occupancy": {
            "occupies_slot": backing_infra == "present",
            "backing_infra": backing_infra,
            "reason": (
                "backing_infra_present" if backing_infra == "present" else "authoritative_absence"
            ),
        },
    }


def _get_deployment_record(deployment_id: str) -> dict[str, Any]:
    deployment = DEPLOYMENTS.get(deployment_id)
    if deployment is None:
        raise HTTPException(status_code=404, detail="Deployment not found")
    return deployment


DEPLOYMENTS: dict[str, dict[str, Any]] = {DEV_V2_DEPLOYMENT_ID: _deployment()}

app = FastAPI(title="Clawdi local deploy API mock")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/me")
async def me() -> dict[str, Any]:
    now = _iso(_now() - timedelta(days=14))
    return {
        "id": "usr_dev_preview",
        "clerk_id": _clerk_id(),
        "email": os.getenv("DEV_AUTH_EMAIL", "e2e-byok-pi-0606-0425@example.com"),
        "name": os.getenv("DEV_AUTH_NAME", "E2E BYOK PI User"),
        "created_at": now,
        "updated_at": _iso(_now()),
        "settings": {
            "v2": {"enabled": True, "source": "rule_clerk_id"},
            "hosted_agents": {"enabled": True, "source": "rule_clerk_id"},
        },
        "evm_wallet_address": None,
        "capabilities": {"can_use_v1": True, "can_use_v2": True},
    }


@app.get("/v2/deployments")
async def list_deployments() -> list[dict[str, Any]]:
    return [_deployment_read_response(record) for record in DEPLOYMENTS.values()]


@app.post("/v2/deployments")
async def create_deployment(request: Request) -> dict[str, Any]:
    body = await request.json()
    deployment_id = f"hdep_dev_{uuid.uuid4().hex[:8]}"
    enabled_optional = []
    if body.get("enable_openclaw", True):
        enabled_optional.append("openclaw")
    if body.get("enable_hermes", False):
        enabled_optional.append("hermes")
    agents = ["codex", *enabled_optional]
    config = _base_config()
    config["compute_plan_slug"] = body.get("compute_plan_slug", "compute_basic")
    config["enable_openclaw"] = "openclaw" in enabled_optional
    config["enable_hermes"] = "hermes" in enabled_optional
    config["onboarded_agents"] = agents
    config["configured_agents"] = agents
    config["clawdi_cloud_environments"] = {runtime: _runtime_env_id(runtime) for runtime in agents}
    primary_model_raw = body.get("primary_model")
    primary_model = _primary_model_value(primary_model_raw) or "openai/gpt-4o-mini"
    primary_provider_id = (
        body.get("ai_provider_id") or _primary_provider_id(primary_model_raw) or DEV_V2_PROVIDER_ID
    )
    if primary_provider_id == "managed":
        primary_provider_id = DEV_V2_MANAGED_PROVIDER_ID
    provider_ids = _provider_ids(body, primary_provider_id)
    config["primary_model"] = primary_model
    config["ai_provider_id"] = primary_provider_id
    config["ai_provider_auth_kind"] = body.get("ai_provider_auth_kind") or "managed"
    config["ai_provider_bindings"] = {
        runtime: {
            "provider_id": primary_provider_id,
            "provider_ids": provider_ids,
            "auth_kind": config["ai_provider_auth_kind"],
            "primary_model": _primary_model_ref(primary_provider_id, primary_model),
        }
        for runtime in agents
    }
    created = _deployment(
        deployment_id=deployment_id,
        name=body.get("assistant_name") or f"dev-agent-{deployment_id[-4:]}",
        status="provisioning",
        config_info=config,
    )
    DEPLOYMENTS[deployment_id] = created
    return created


@app.get("/v2/deployments/{deployment_id}")
async def get_deployment(deployment_id: str) -> dict[str, Any]:
    return _deployment_read_response(_get_deployment_record(deployment_id))


@app.patch("/v2/deployments/{deployment_id}")
async def update_deployment(deployment_id: str, request: Request) -> dict[str, Any]:
    deployment = _get_deployment_record(deployment_id)
    body = await request.json()
    next_name = body.get("name") or body.get("assistant_name")
    if isinstance(next_name, str) and next_name.strip():
        deployment["name"] = next_name.strip()
    return deployment


@app.delete("/v2/deployments/{deployment_id}")
async def delete_deployment(deployment_id: str) -> dict[str, Any]:
    existed = DEPLOYMENTS.pop(deployment_id, None) is not None
    return {"status": "deleted" if existed else "missing", "cvm_deleted": existed}


@app.patch("/v2/deployments/{deployment_id}/agents/{agent_type}")
async def set_agent_enabled(
    deployment_id: str,
    agent_type: str,
    request: Request,
) -> dict[str, Any]:
    deployment = _get_deployment_record(deployment_id)
    body = await request.json()
    enabled = bool(body.get("enabled"))
    config = deployment["config_info"]
    if agent_type not in {"codex", "openclaw", "hermes"}:
        raise HTTPException(status_code=400, detail="Unsupported runtime")
    if agent_type == "codex":
        if not enabled:
            raise HTTPException(status_code=400, detail="Codex is always enabled")
        onboarded = set(config.get("onboarded_agents") or [])
        configured = set(config.get("configured_agents") or [])
        onboarded.add("codex")
        configured.add("codex")
        config["onboarded_agents"] = _ordered_agents(onboarded)
        config["configured_agents"] = _ordered_agents(configured)
        envs = dict(config.get("clawdi_cloud_environments") or {})
        envs["codex"] = _runtime_env_id("codex")
        config["clawdi_cloud_environments"] = envs
        return deployment
    config[f"enable_{agent_type}"] = enabled
    onboarded = set(config.get("onboarded_agents") or [])
    if enabled:
        onboarded.add(agent_type)
    else:
        onboarded.discard(agent_type)
    config["onboarded_agents"] = _ordered_agents(onboarded)
    return deployment


@app.patch("/v2/deployments/{deployment_id}/agents/{agent_type}/ai-provider")
async def set_agent_ai_provider(
    deployment_id: str,
    agent_type: str,
    request: Request,
) -> dict[str, Any]:
    deployment = _get_deployment_record(deployment_id)
    body = await request.json()
    if agent_type not in {"codex", "openclaw", "hermes"}:
        raise HTTPException(status_code=400, detail="Unsupported runtime")
    config = deployment["config_info"]
    bindings = dict(config.get("ai_provider_bindings") or {})
    primary_model_raw = body.get("primary_model")
    primary_model = _primary_model_value(primary_model_raw) or "openai/gpt-4o-mini"
    primary_provider_id = (
        body.get("ai_provider_id")
        or _primary_provider_id(primary_model_raw)
        or DEV_V2_MANAGED_PROVIDER_ID
    )
    if primary_provider_id == "managed":
        primary_provider_id = DEV_V2_MANAGED_PROVIDER_ID
    bindings[agent_type] = {
        "provider_id": primary_provider_id,
        "provider_ids": _provider_ids(body, primary_provider_id),
        "auth_kind": body.get("ai_provider_auth_kind") or "managed",
        "primary_model": _primary_model_ref(primary_provider_id, primary_model),
    }
    config["ai_provider_bindings"] = bindings
    config["ai_provider_id"] = bindings[agent_type]["provider_id"]
    config["ai_provider_auth_kind"] = bindings[agent_type]["auth_kind"]
    config["primary_model"] = primary_model
    return deployment


@app.post("/v2/deployments/{deployment_id}/onboard-agent")
async def onboard_agent(deployment_id: str, request: Request) -> dict[str, Any]:
    body = await request.json()
    deployment = _get_deployment_record(deployment_id)
    agent_type = body.get("agent_type", "openclaw")
    if agent_type not in {"codex", "openclaw", "hermes"}:
        raise HTTPException(status_code=400, detail="Unsupported runtime")
    config = deployment["config_info"]
    bindings = dict(config.get("ai_provider_bindings") or {})
    explicit_provider = any(
        body.get(key)
        for key in ("ai_provider_auth_kind", "ai_provider_id", "ai_provider_bootstrap")
    )
    if agent_type not in bindings:
        source = next(
            (
                bindings.get(runtime)
                for runtime in ("codex", "openclaw", "hermes")
                if runtime != agent_type and isinstance(bindings.get(runtime), dict)
            ),
            None,
        )
        if explicit_provider or source is None:
            primary_model_raw = body.get("primary_model")
            primary_model = (
                _primary_model_value(primary_model_raw)
                or _primary_model_value(config.get("primary_model"))
                or "openai/gpt-4o-mini"
            )
            primary_provider_id = (
                body.get("ai_provider_id")
                or _primary_provider_id(primary_model_raw)
                or DEV_V2_MANAGED_PROVIDER_ID
            )
            if primary_provider_id == "managed":
                primary_provider_id = DEV_V2_MANAGED_PROVIDER_ID
            binding = {
                "provider_id": primary_provider_id,
                "provider_ids": _provider_ids(body, primary_provider_id),
                "auth_kind": body.get("ai_provider_auth_kind") or "managed",
                "primary_model": _primary_model_ref(primary_provider_id, primary_model),
            }
            bootstrap = body.get("ai_provider_bootstrap")
        else:
            primary_model_raw = body.get("primary_model")
            primary_model = (
                _primary_model_value(primary_model_raw)
                or _primary_model_value(source.get("primary_model"))
                or _primary_model_value(config.get("primary_model"))
                or "openai/gpt-4o-mini"
            )
            primary_provider_id = (
                _primary_provider_id(primary_model_raw)
                or _primary_provider_id(source.get("primary_model"))
                or source.get("provider_id")
                or DEV_V2_MANAGED_PROVIDER_ID
            )
            if primary_provider_id == "managed":
                primary_provider_id = DEV_V2_MANAGED_PROVIDER_ID
            binding = {
                "provider_id": primary_provider_id,
                "provider_ids": source.get("provider_ids") or [primary_provider_id],
                "auth_kind": source.get("auth_kind") or "managed",
                "primary_model": _primary_model_ref(primary_provider_id, primary_model),
            }
            bootstrap = source.get("bootstrap")
        if isinstance(bootstrap, dict):
            binding["bootstrap"] = bootstrap
        bindings[agent_type] = binding
        config["ai_provider_bindings"] = bindings
        config["ai_provider_id"] = binding["provider_id"]
        config["ai_provider_auth_kind"] = binding["auth_kind"]
        config["primary_model"] = _primary_model_value(binding["primary_model"])
    if agent_type != "codex":
        config[f"enable_{agent_type}"] = True
    onboarded = set(config.get("onboarded_agents") or [])
    onboarded.add(agent_type)
    config["onboarded_agents"] = _ordered_agents(onboarded)
    configured = set(config.get("configured_agents") or [])
    configured.add(agent_type)
    config["configured_agents"] = _ordered_agents(configured)
    envs = dict(config.get("clawdi_cloud_environments") or {})
    envs[agent_type] = _runtime_env_id(agent_type)
    config["clawdi_cloud_environments"] = envs
    return deployment


@app.post("/v2/deployments/{deployment_id}/terminal")
async def create_terminal_session(
    deployment_id: str,
    request: Request,
) -> dict[str, Any]:
    deployment = _get_deployment_record(deployment_id)
    if deployment.get("status") not in {"running", "ready"}:
        raise HTTPException(
            status_code=409,
            detail="Terminal is available only while the deployment is running.",
        )
    session_id = f"term_{uuid.uuid4().hex[:10]}"
    fragment = urlencode({"token": session_id})
    websocket_url = f"{_ws_base_url(request)}/v2/deployments/{deployment_id}/terminal/ws#{fragment}"
    return {
        "deployment_id": deployment_id,
        "websocket_url": websocket_url,
        "expires_at": _iso(_now() + timedelta(minutes=30)),
    }


@app.websocket("/v2/deployments/{deployment_id}/terminal/ws")
async def mock_terminal_ws(websocket: WebSocket, deployment_id: str) -> None:
    deployment = DEPLOYMENTS.get(deployment_id)
    if deployment is None or deployment.get("status") not in {"running", "ready"}:
        await websocket.close(code=1008)
        return

    protocols = websocket.headers.get("sec-websocket-protocol", "")
    subprotocol = "tty" if "tty" in {value.strip() for value in protocols.split(",")} else None
    await websocket.accept(subprotocol=subprotocol)
    await websocket.send_text(
        f"0Clawdi mock terminal - {deployment_id}\r\nwhoami: clawdi\r\ncwd: /home/clawdi\r\n$ "
    )

    buffer = ""
    try:
        while True:
            message = await websocket.receive_text()
            if not message or message[0] in {"{", "1"}:
                continue
            if message[0] != "0":
                continue

            data = message[1:]
            for char in data:
                if char == "\x03":
                    buffer = ""
                    await websocket.send_text("0^C\r\n$ ")
                    continue
                if char in {"\r", "\n"}:
                    command = buffer.strip()
                    buffer = ""
                    await websocket.send_text(f"0\r\n{_mock_terminal_command(command)}$ ")
                    continue
                if char == "\x7f":
                    buffer = buffer[:-1]
                    await websocket.send_text("0\b \b")
                    continue
                buffer += char
                await websocket.send_text(f"0{char}")
    except WebSocketDisconnect:
        return


def _mock_terminal_command(command: str) -> str:
    if not command:
        return ""
    if command == "pwd":
        return "/home/clawdi\r\n"
    if command == "whoami":
        return "clawdi\r\n"
    if command == "clear":
        return "\x1b[2J\x1b[H"
    return f"mock: command received: {command}\r\n"


@app.post("/v2/deployments/{deployment_id}/restart")
async def restart_deployment(deployment_id: str) -> dict[str, Any]:
    deployment = _get_deployment_record(deployment_id)
    deployment["status"] = "running"
    return {"status": "restarting", "upgrade_task_id": None, "upgrade_status": None}


@app.post("/v2/deployments/{deployment_id}/stop")
async def stop_deployment(deployment_id: str) -> dict[str, Any]:
    deployment = _get_deployment_record(deployment_id)
    deployment["status"] = "stopped"
    return {"status": "stopped", "upgrade_task_id": None, "upgrade_status": None}


@app.post("/v2/deployments/{deployment_id}/start")
async def start_deployment(deployment_id: str) -> dict[str, Any]:
    deployment = _get_deployment_record(deployment_id)
    deployment["status"] = "running"
    return {"status": "starting", "upgrade_task_id": None, "upgrade_status": None}


@app.get("/v2/subscription/plans")
async def plans() -> list[dict[str, Any]]:
    return [
        {
            "slug": "compute_basic",
            "name": "Basic",
            "price_cents": 0,
            "points_per_usd": 100,
            "signup_grant_credits": 500,
            "subscription_grant_credits": 0,
            "vcpu": 1,
            "ram_gb": 2,
            "disk_size": 20,
            "instance_type": "dev-free",
            "offers": [],
        },
        {
            "slug": "compute_performance",
            "name": "Performance",
            "price_cents": 1900,
            "points_per_usd": 100,
            "signup_grant_credits": 500,
            "subscription_grant_credits": 500,
            "vcpu": 4,
            "ram_gb": 8,
            "disk_size": 80,
            "instance_type": "dev-performance",
            "offers": [
                {
                    "billing_term_months": 1,
                    "price_cents": 1900,
                    "effective_monthly_price_cents": 1900,
                    "discount_percent": 0,
                },
                {
                    "billing_term_months": 12,
                    "price_cents": 19000,
                    "effective_monthly_price_cents": 1583,
                    "discount_percent": 17,
                },
            ],
        },
    ]


@app.post("/v2/subscription/checkout")
async def checkout() -> dict[str, Any]:
    return {
        "flow_type": "checkout_session",
        "action_url": None,
        "checkout_url": f"{_web_base_url()}/deploy?mockCheckout=1",
        "client_secret": None,
    }


@app.post("/v2/subscription/portal")
async def portal() -> dict[str, Any]:
    portal_url = f"{_web_base_url()}/?settings=billing-plan&mockPortal=1"
    return {
        "url": portal_url,
        "portal_url": portal_url,
        "status": "mock",
    }


@app.get("/v2/usage")
async def usage() -> dict[str, Any]:
    today = _now().date()
    return {
        "period_start": str(today - timedelta(days=6)),
        "period_end": str(today),
        "total_credits": 1280,
        "total_requests": 94,
        "by_model": [
            {
                "model": "openai/gpt-4o-mini",
                "provider": DEV_V2_PROVIDER_ID,
                "credits": 980,
                "requests": 72,
            },
            {"model": "managed/default", "provider": "clawdi", "credits": 300, "requests": 22},
        ],
        "by_day": [
            {"date": str(today - timedelta(days=i)), "credits": 120 + i * 25}
            for i in reversed(range(7))
        ],
    }


@app.get("/v2/wallet")
async def wallet() -> dict[str, Any]:
    return {
        "balance_credits": 4200,
        "balance_snapshot_at": _iso(_now()),
        "payment_mode": "card",
        "auto_reload_enabled": True,
        "auto_reload_threshold_credits": 1000,
        "auto_reload_amount_cents": 1000,
        "auto_reload_monthly_cap_cents": 5000,
        "auto_reload_action": None,
        "points_per_usd": 100,
    }


@app.get("/v2/wallet/ledger")
async def ledger() -> dict[str, Any]:
    now = _now()
    return {
        "items": [
            {
                "id": "ledger_dev_topup",
                "operation": "topup",
                "request_id": "req_dev_topup",
                "credits_amount": 5000,
                "status": "applied",
                "notes": "Mock top-up",
                "created_at": _iso(now - timedelta(days=2)),
                "applied_at": _iso(now - timedelta(days=2)),
            },
            {
                "id": "ledger_dev_usage",
                "operation": "usage",
                "request_id": "req_dev_usage",
                "credits_amount": -800,
                "status": "applied",
                "notes": "Hosted runtime usage",
                "created_at": _iso(now - timedelta(hours=4)),
                "applied_at": _iso(now - timedelta(hours=4)),
            },
        ]
    }


@app.post("/v2/wallet/topup")
async def topup() -> dict[str, Any]:
    return {
        "status": "succeeded",
        "flow_type": "mock",
        "payment_intent_id": "pi_dev_mock",
        "client_secret": None,
        "credits_added": 1000,
    }


@app.put("/v2/wallet/auto-reload")
async def auto_reload(request: Request) -> dict[str, Any]:
    body = await request.json()
    state = await wallet()
    state.update({k: v for k, v in body.items() if v is not None})
    return state


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=50001)
    args = parser.parse_args()

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port)
