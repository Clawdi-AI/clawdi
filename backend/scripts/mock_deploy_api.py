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


def _runtime_env_id(runtime_type: str) -> str:
    if runtime_type == "codex":
        return _codex_env_id()
    if runtime_type == "openclaw":
        return _openclaw_env_id()
    if runtime_type == "hermes":
        return _hermes_env_id()
    raise HTTPException(status_code=400, detail="Unsupported runtime")


def _runtime_type_order(runtime_type: str) -> int:
    return {"codex": 0, "openclaw": 1, "hermes": 2}.get(runtime_type, 99)


def _ordered_runtime_types(values: set[str]) -> list[str]:
    return sorted(values, key=lambda value: _runtime_type_order(value))


def _ordered_agent_ids(config_info: dict[str, Any], values: set[str]) -> list[str]:
    targets = _runtime_targets(config_info)
    return sorted(
        values,
        key=lambda value: (_runtime_type_order(str(targets.get(value, {}).get("type"))), value),
    )


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
        "ai_provider_bindings": {
            "codex": {
                "provider_id": DEV_V2_PROVIDER_ID,
                "auth_kind": "api_key",
                "primary_model": "openai/gpt-4o-mini",
            },
            "openclaw": {
                "provider_id": DEV_V2_PROVIDER_ID,
                "auth_kind": "api_key",
                "primary_model": "openai/gpt-4o-mini",
            },
            "hermes": {
                "provider_id": DEV_V2_PROVIDER_ID,
                "auth_kind": "api_key",
                "primary_model": "openai/gpt-4o-mini",
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
        "runtime_targets": {
            "codex": {
                "id": "codex",
                "type": "codex",
                "display_name": "Codex",
                "enabled": True,
                "environment_id": _codex_env_id(),
                "image": {"ref": "clawdi/codex-runtime:dev", "tag": "dev"},
                "version": {"desired": "dev", "observed": "dev", "upgrade_policy": "manual"},
                "execution": {
                    "terminal": {
                        "container": "codex",
                        "user": "clawdi",
                        "cwd": "/home/clawdi/clawdi",
                    }
                },
            },
            "openclaw": {
                "id": "openclaw",
                "type": "openclaw",
                "display_name": "OpenClaw",
                "enabled": True,
                "environment_id": _openclaw_env_id(),
                "control_ui_url": "https://openclaw.dev-preview.local",
                "image": {"ref": "ghcr.io/openclaw/openclaw:2026.6.11", "tag": "2026.6.11"},
                "version": {
                    "desired": "2026.6.11",
                    "observed": "OpenClaw 2026.6.11",
                    "upgrade_policy": "pinned",
                },
                "execution": {
                    "terminal": {
                        "container": "openclaw",
                        "user": "node",
                        "cwd": "/home/node/.openclaw/workspace",
                    }
                },
            },
            "hermes": {
                "id": "hermes",
                "type": "hermes",
                "display_name": "Hermes",
                "enabled": True,
                "environment_id": _hermes_env_id(),
                "control_ui_url": "https://hermes.dev-preview.local",
                "image": {"ref": "ghcr.io/nousresearch/hermes-agent:0.17.0", "tag": "0.17.0"},
                "version": {
                    "desired": "0.17.0",
                    "observed": "Hermes Agent v0.17.0",
                    "upgrade_policy": "pinned",
                },
                "execution": {
                    "terminal": {
                        "container": "hermes",
                        "user": "hermes",
                        "cwd": "/opt/data/workspace",
                    }
                },
            },
        },
        "onboarded_agent_ids": ["codex", "openclaw", "hermes"],
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
    return list(DEPLOYMENTS.values())


@app.post("/v2/deployments")
async def create_deployment(request: Request) -> dict[str, Any]:
    body = await request.json()
    deployment_id = f"hdep_dev_{uuid.uuid4().hex[:8]}"
    enabled_optional = []
    if body.get("enable_openclaw", True):
        enabled_optional.append("openclaw")
    if body.get("enable_hermes", False):
        enabled_optional.append("hermes")
    runtime_types = ["codex", *enabled_optional]
    config = _base_config()
    config["compute_plan_slug"] = body.get("compute_plan_slug", "compute_free")
    config["enable_openclaw"] = "openclaw" in enabled_optional
    config["enable_hermes"] = "hermes" in enabled_optional
    config["onboarded_agents"] = runtime_types
    config["configured_agents"] = runtime_types
    config["clawdi_cloud_environments"] = {
        runtime_type: _runtime_env_id(runtime_type) for runtime_type in runtime_types
    }
    targets = {
        target_id: target
        for target_id, target in _runtime_targets(config).items()
        if target.get("type") in runtime_types
    }
    for target_id, target in targets.items():
        target["enabled"] = True
        target["environment_id"] = config["clawdi_cloud_environments"].get(target_id)
    config["runtime_targets"] = targets
    config["onboarded_agent_ids"] = list(targets)
    config["primary_model"] = body.get("primary_model") or "openai/gpt-4o-mini"
    config["ai_provider_id"] = body.get("ai_provider_id") or DEV_V2_PROVIDER_ID
    config["ai_provider_auth_kind"] = body.get("ai_provider_auth_kind") or "managed"
    config["ai_provider_bindings"] = {
        runtime_type: {
            "provider_id": config["ai_provider_id"],
            "auth_kind": config["ai_provider_auth_kind"],
            "primary_model": config["primary_model"],
        }
        for runtime_type in runtime_types
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
    deployment = DEPLOYMENTS.get(deployment_id)
    if deployment is None:
        raise HTTPException(status_code=404, detail="Deployment not found")
    return deployment


@app.patch("/v2/deployments/{deployment_id}")
async def update_deployment(deployment_id: str, request: Request) -> dict[str, Any]:
    deployment = await get_deployment(deployment_id)
    body = await request.json()
    next_name = body.get("name") or body.get("assistant_name")
    if isinstance(next_name, str) and next_name.strip():
        deployment["name"] = next_name.strip()
    return deployment


@app.delete("/v2/deployments/{deployment_id}")
async def delete_deployment(deployment_id: str) -> dict[str, Any]:
    existed = DEPLOYMENTS.pop(deployment_id, None) is not None
    return {"status": "deleted" if existed else "missing", "cvm_deleted": existed}


@app.patch("/v2/deployments/{deployment_id}/agent-targets/{agent_id}")
async def set_agent_target_enabled(
    deployment_id: str,
    agent_id: str,
    request: Request,
) -> dict[str, Any]:
    deployment = await get_deployment(deployment_id)
    body = await request.json()
    enabled = bool(body.get("enabled"))
    config = deployment["config_info"]
    targets = _runtime_targets(config)
    target = targets.get(agent_id)
    if not target:
        raise HTTPException(status_code=400, detail="Unsupported runtime target")
    if target.get("type") == "codex" and not enabled:
        raise HTTPException(status_code=400, detail="Codex target is always enabled")
    target["enabled"] = enabled
    config["runtime_targets"] = targets
    onboarded_ids = {
        target_id for target_id, item in targets.items() if item.get("enabled") is True
    }
    config["onboarded_agent_ids"] = _ordered_agent_ids(config, onboarded_ids)
    enabled_types = {
        str(item.get("type")) for item in targets.values() if item.get("enabled") is True
    }
    config["onboarded_agents"] = _ordered_runtime_types(enabled_types)
    config["enable_openclaw"] = "openclaw" in enabled_types
    config["enable_hermes"] = "hermes" in enabled_types
    return deployment


@app.patch("/v2/deployments/{deployment_id}/agent-targets/{agent_id}/ai-provider")
async def set_agent_target_ai_provider(
    deployment_id: str,
    agent_id: str,
    request: Request,
) -> dict[str, Any]:
    deployment = await get_deployment(deployment_id)
    body = await request.json()
    config = deployment["config_info"]
    target = _runtime_targets(config).get(agent_id)
    if not target:
        raise HTTPException(status_code=400, detail="Unsupported runtime target")
    bindings = dict(config.get("ai_provider_bindings") or {})
    bindings[agent_id] = {
        "provider_id": body.get("ai_provider_id") or "managed",
        "auth_kind": body.get("ai_provider_auth_kind") or "managed",
        "primary_model": body.get("primary_model") or "openai/gpt-4o-mini",
    }
    config["ai_provider_bindings"] = bindings
    config["ai_provider_id"] = bindings[agent_id]["provider_id"]
    config["ai_provider_auth_kind"] = bindings[agent_id]["auth_kind"]
    config["primary_model"] = bindings[agent_id]["primary_model"]
    return deployment


@app.post("/v2/deployments/{deployment_id}/terminal")
async def create_terminal_session(
    deployment_id: str,
    request: Request,
) -> dict[str, Any]:
    deployment = await get_deployment(deployment_id)
    try:
        body = await request.json()
    except Exception:
        body = {}
    config_info = deployment.get("config_info", {})
    agent_id, runtime_type = _resolve_terminal_target(config_info, body)
    if not _is_target_enabled(config_info, agent_id, runtime_type):
        raise HTTPException(status_code=409, detail=f"{agent_id} runtime is not enabled.")
    if _terminal_target(config_info, agent_id) is None:
        raise HTTPException(
            status_code=409,
            detail=f"{agent_id} terminal target is not configured.",
        )
    if deployment.get("status") not in {"running", "ready"}:
        raise HTTPException(
            status_code=409,
            detail="Terminal is available only while the deployment is running.",
        )
    session_id = f"term_{uuid.uuid4().hex[:10]}"
    query = urlencode({"agent_id": agent_id})
    fragment = urlencode({"token": session_id})
    websocket_url = (
        f"{_ws_base_url(request)}/v2/deployments/{deployment_id}/terminal/ws?{query}#{fragment}"
    )
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
    agent_id = websocket.query_params.get("agent_id")
    config_info = deployment.get("config_info", {})
    try:
        agent_id, runtime_type = _resolve_terminal_target(config_info, {"agent_id": agent_id})
    except HTTPException:
        await websocket.close(code=1008)
        return
    target = _terminal_target(config_info, agent_id)
    if target is None:
        await websocket.close(code=1008)
        return

    protocols = websocket.headers.get("sec-websocket-protocol", "")
    subprotocol = "tty" if "tty" in {value.strip() for value in protocols.split(",")} else None
    await websocket.accept(subprotocol=subprotocol)
    await websocket.send_text(
        "0"
        f"Clawdi mock terminal - {deployment_id} ({agent_id}, {runtime_type})\r\n"
        f"container: {target['container']}\r\n"
        f"whoami: {target['user']}\r\n"
        f"cwd: {target['cwd']}\r\n"
        "$ "
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
                    await websocket.send_text(f"0\r\n{_mock_terminal_command(command, target)}$ ")
                    continue
                if char == "\x7f":
                    buffer = buffer[:-1]
                    await websocket.send_text("0\b \b")
                    continue
                buffer += char
                await websocket.send_text(f"0{char}")
    except WebSocketDisconnect:
        return


def _runtime_targets(config_info: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = config_info.get("runtime_targets")
    if isinstance(raw, dict):
        return {
            str(target_id): dict(target)
            for target_id, target in raw.items()
            if isinstance(target, dict) and isinstance(target.get("type"), str)
        }
    return {}


def _resolve_terminal_target(config_info: dict[str, Any], body: dict[str, Any]) -> tuple[str, str]:
    targets = _runtime_targets(config_info)
    agent_id = body.get("agent_id")
    if not isinstance(agent_id, str) or not agent_id:
        raise HTTPException(status_code=400, detail="agent_id is required")
    target = targets.get(agent_id)
    if not target:
        raise HTTPException(status_code=400, detail="Unsupported runtime target")
    runtime_type = target.get("type")
    if runtime_type not in {"codex", "openclaw", "hermes"}:
        raise HTTPException(status_code=400, detail="Unsupported runtime")
    return agent_id, str(runtime_type)


def _is_target_enabled(config_info: dict[str, Any], agent_id: str, runtime_type: str) -> bool:
    targets = _runtime_targets(config_info)
    target = targets.get(agent_id) or {}
    return target.get("type") == runtime_type and target.get("enabled") is True


def _terminal_target(config_info: dict[str, Any], agent_id: str) -> dict[str, str] | None:
    target = _runtime_targets(config_info).get(agent_id)
    execution = target.get("execution") if isinstance(target, dict) else None
    terminal = execution.get("terminal") if isinstance(execution, dict) else None
    if not isinstance(terminal, dict):
        return None
    container = terminal.get("container")
    user = terminal.get("user")
    cwd = terminal.get("cwd")
    if not all(isinstance(value, str) and value for value in (container, user, cwd)):
        return None
    return {"container": container, "user": user, "cwd": cwd}


def _mock_terminal_command(command: str, target: dict[str, str]) -> str:
    if not command:
        return ""
    if command == "pwd":
        return f"{target['cwd']}\r\n"
    if command == "whoami":
        return f"{target['user']}\r\n"
    if command == "clear":
        return "\x1b[2J\x1b[H"
    return f"mock: command received: {command}\r\n"


@app.post("/v2/deployments/{deployment_id}/restart")
async def restart_deployment(deployment_id: str) -> dict[str, Any]:
    deployment = await get_deployment(deployment_id)
    deployment["status"] = "running"
    return {"status": "restarting", "upgrade_task_id": None, "upgrade_status": None}


@app.post("/v2/deployments/{deployment_id}/stop")
async def stop_deployment(deployment_id: str) -> dict[str, Any]:
    deployment = await get_deployment(deployment_id)
    deployment["status"] = "stopped"
    return {"status": "stopped", "upgrade_task_id": None, "upgrade_status": None}


@app.post("/v2/deployments/{deployment_id}/start")
async def start_deployment(deployment_id: str) -> dict[str, Any]:
    deployment = await get_deployment(deployment_id)
    deployment["status"] = "running"
    return {"status": "starting", "upgrade_task_id": None, "upgrade_status": None}


@app.get("/v2/subscription/plans")
async def plans() -> list[dict[str, Any]]:
    return [
        {
            "slug": "compute_free",
            "name": "Free",
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
