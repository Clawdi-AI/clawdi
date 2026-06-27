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

from fastapi import FastAPI, HTTPException, Request
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


def _hermes_env_id() -> str:
    return os.getenv("MOCK_HERMES_ENV_ID") or _stable_uuid(_clerk_id(), "hosted-hermes-env")


def _web_base_url() -> str:
    return os.getenv("MOCK_WEB_BASE_URL", "http://localhost:3001").rstrip("/")


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
        "onboarded_agents": ["openclaw", "hermes"],
        "configured_agents": ["openclaw", "hermes"],
        "clawdi_cloud_environments": {
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
            "https://openclaw.dev-preview.local",
            "https://hermes.dev-preview.local",
        ],
        "gateway_token": None,
        "ui_access_token": None,
        "openclaw_ui_url": "https://openclaw.dev-preview.local",
        "hermes_ui_url": "https://hermes.dev-preview.local",
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
    enabled = []
    if body.get("enable_openclaw", True):
        enabled.append("openclaw")
    if body.get("enable_hermes", False):
        enabled.append("hermes")
    if not enabled:
        enabled = ["openclaw"]
    config = _base_config()
    config["compute_plan_slug"] = body.get("compute_plan_slug", "compute_free")
    config["enable_openclaw"] = "openclaw" in enabled
    config["enable_hermes"] = "hermes" in enabled
    config["onboarded_agents"] = enabled
    config["configured_agents"] = enabled
    config["primary_model"] = body.get("primary_model") or "openai/gpt-4o-mini"
    config["ai_provider_id"] = body.get("ai_provider_id") or DEV_V2_PROVIDER_ID
    config["ai_provider_auth_kind"] = body.get("ai_provider_auth_kind") or "managed"
    config["ai_provider_bindings"] = {
        runtime: {
            "provider_id": config["ai_provider_id"],
            "auth_kind": config["ai_provider_auth_kind"],
            "primary_model": config["primary_model"],
        }
        for runtime in enabled
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


@app.patch("/v2/deployments/{deployment_id}/agents/{agent_type}")
async def set_agent_enabled(
    deployment_id: str,
    agent_type: str,
    request: Request,
) -> dict[str, Any]:
    deployment = await get_deployment(deployment_id)
    body = await request.json()
    enabled = bool(body.get("enabled"))
    config = deployment["config_info"]
    if agent_type not in {"openclaw", "hermes"}:
        raise HTTPException(status_code=400, detail="Unsupported runtime")
    config[f"enable_{agent_type}"] = enabled
    onboarded = set(config.get("onboarded_agents") or [])
    if enabled:
        onboarded.add(agent_type)
    else:
        onboarded.discard(agent_type)
    config["onboarded_agents"] = sorted(onboarded)
    return deployment


@app.patch("/v2/deployments/{deployment_id}/agents/{agent_type}/ai-provider")
async def set_agent_ai_provider(
    deployment_id: str,
    agent_type: str,
    request: Request,
) -> dict[str, Any]:
    deployment = await get_deployment(deployment_id)
    body = await request.json()
    config = deployment["config_info"]
    bindings = dict(config.get("ai_provider_bindings") or {})
    bindings[agent_type] = {
        "provider_id": body.get("ai_provider_id") or "managed",
        "auth_kind": body.get("ai_provider_auth_kind") or "managed",
        "primary_model": body.get("primary_model") or "openai/gpt-4o-mini",
    }
    config["ai_provider_bindings"] = bindings
    config["ai_provider_id"] = bindings[agent_type]["provider_id"]
    config["ai_provider_auth_kind"] = bindings[agent_type]["auth_kind"]
    config["primary_model"] = bindings[agent_type]["primary_model"]
    return deployment


@app.post("/v2/deployments/{deployment_id}/onboard-agent")
async def onboard_agent(deployment_id: str, request: Request) -> dict[str, Any]:
    body = await request.json()
    deployment = await get_deployment(deployment_id)
    agent_type = body.get("agent_type", "openclaw")
    if agent_type not in {"openclaw", "hermes"}:
        raise HTTPException(status_code=400, detail="Unsupported runtime")
    config = deployment["config_info"]
    config[f"enable_{agent_type}"] = True
    onboarded = set(config.get("onboarded_agents") or [])
    onboarded.add(agent_type)
    config["onboarded_agents"] = sorted(onboarded)
    return deployment


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
            "monthly_budget_credits": 1000,
            "points_per_usd": 100,
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
            "monthly_budget_credits": 10000,
            "points_per_usd": 100,
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


@app.get("/v2/subscription/current")
async def subscription() -> dict[str, Any]:
    now = _now()
    return {
        "id": "sub_dev_preview",
        "plan_slug": "compute_performance",
        "payment_provider": "mock",
        "status": "active",
        "current_period_start": _iso(now - timedelta(days=5)),
        "current_period_end": _iso(now + timedelta(days=25)),
        "budget_credits_total": 10000,
        "budget_credits_used": 1234,
        "addon_credits_remaining": 4200,
        "points_per_usd": 100,
        "use_addon_credits": True,
        "cancel_at_period_end": False,
        "billing_term_months": 1,
        "billing_price_cents_snapshot": 1900,
        "card_on_file": True,
        "card_setup_required": False,
        "card_brand": "visa",
        "card_last4": "4242",
        "card_exp_month": 12,
        "card_exp_year": 2030,
        "created_at": _iso(now - timedelta(days=5)),
        "collection_method": "charge_automatically",
        "entitled": True,
        "activation_fee_amount_cents": 0,
        "activation_fee_satisfied": True,
    }


@app.get("/v2/subscription/activation-fee")
async def activation_fee() -> dict[str, Any]:
    return {"amount_cents": 0, "satisfied": True}


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
