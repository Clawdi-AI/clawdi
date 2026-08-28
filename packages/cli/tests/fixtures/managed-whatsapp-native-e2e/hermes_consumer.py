from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import aiohttp
from gateway.config import PlatformConfig
from gateway.platform_registry import platform_registry
from hermes_cli.plugins import discover_plugins

CONTROL_BASE = "http://127.0.0.1:9000"
CHAT_JID = "184207372460253@lid"


async def main() -> None:
    projection = json.loads(
        (Path(required_environment("E2E_OUTPUT")) / "projection.json").read_text(encoding="utf-8")
    )
    if projection.get("runtime") != "hermes":
        raise RuntimeError("stock Hermes consumer requires a Hermes projection")

    os.environ["HOME"] = projection["home"]
    for key, value in projection["run"]["env"].items():
        os.environ[key] = value
    if os.environ.get("WHATSAPP_ALLOWED_USERS") != "*":
        raise RuntimeError("managed Hermes projection must use the stock bridge wildcard")
    if os.environ.get("WHATSAPP_ALLOW_ALL_USERS") != "true":
        raise RuntimeError("managed Hermes projection must explicitly opt in to allow all users")
    if os.environ.get("WHATSAPP_DM_POLICY") != "open":
        raise RuntimeError("managed Hermes projection must use the stock open DM policy")
    if os.environ.get("WHATSAPP_GROUP_POLICY") != "open":
        raise RuntimeError("managed Hermes projection must use the stock open group policy")
    discover_plugins()

    received: list[dict[str, Any]] = []
    config = platform_config(projection)

    async def handle_message(event: Any) -> str:
        received.append(
            {
                "text": event.text,
                "chat_id": event.source.chat_id,
                "message_id": event.message_id,
            }
        )
        if "after restart" in event.text:
            return "hermes agent reply after restart"
        return "hermes agent reply"

    adapter = create_adapter(config, handle_message)
    try:
        if not await adapter.connect():
            raise RuntimeError("stock Hermes WhatsApp adapter failed to connect")
        await wait_for(
            lambda: connected_with_bundle(),
            "stock Hermes plugin adapter connection",
        )

        await control_post(
            "/control/push",
            {"message_id": "hermes-inbound-1", "text": "hermes inbound text"},
        )
        await wait_for(
            lambda: hermes_inbound_reply_ready(
                received, "hermes inbound text", "hermes agent reply"
            ),
            "Hermes official adapter inbound and handler reply",
        )

        sent = await adapter.send(CHAT_JID, "hermes outbound text")
        if not sent.success:
            raise RuntimeError(f"Hermes adapter send failed: {sent.error}")
        poll = await adapter.send_poll(
            CHAT_JID,
            "Hermes poll",
            ["A", "B"],
            selectable_count=1,
        )
        if not poll.success:
            raise RuntimeError(f"Hermes adapter poll failed: {poll.error}")
        await adapter.send_typing(CHAT_JID)
        await wait_for(
            hermes_protocol_envelopes_ready,
            "Hermes text, poll, typing, and read envelopes",
        )

        before_515 = await control_status()
        await control_post("/control/restart", {})
        await wait_for(
            lambda: connection_count_exceeds(before_515["connections"]),
            "Hermes stock 515 reconnect",
        )

        before_process_restart = await control_status()
        await adapter.disconnect()
        adapter = create_adapter(config, handle_message)
        if not await adapter.connect():
            raise RuntimeError("Hermes adapter failed to reconnect after process restart")
        await wait_for(
            lambda: reconstructed_after_restart(before_process_restart["connections"]),
            "Hermes plugin process restart auth reconstruction",
        )

        await control_post(
            "/control/push",
            {
                "message_id": "hermes-inbound-2",
                "text": "hermes inbound after restart",
            },
        )
        await wait_for(
            lambda: hermes_inbound_reply_ready(
                received,
                "hermes inbound after restart",
                "hermes agent reply after restart",
            ),
            "Hermes inbound and handler reply after process restart",
        )
        await assert_common_boundary(projection)
    except Exception as exc:
        log_path = Path(projection["authDir"]).parent / "bridge.log"
        log = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        try:
            status_summary = summarize_status(await control_status())
        except Exception as status_exc:
            status_summary = {"unavailable": str(status_exc)}
        raise RuntimeError(
            f"{exc}\nSanitized /control/status summary:\n"
            f"{json.dumps(status_summary, indent=2)}\nHermes bridge log:\n{log[-12000:]}"
        ) from exc
    finally:
        await adapter.disconnect()


def platform_config(projection: dict[str, Any]) -> PlatformConfig:
    whatsapp = projection["channels"]["whatsapp"]
    account_id = whatsapp["defaultAccount"]
    account = whatsapp["accounts"][account_id]
    return PlatformConfig(
        enabled=True,
        gateway_restart_notification=False,
        extra={
            "bridge_script": str(
                Path(projection["appRoot"]) / "scripts" / "whatsapp-bridge" / "bridge.js"
            ),
            "bridge_port": 3100,
            "session_path": projection["authDir"],
            "dm_policy": account["dmPolicy"],
            "allow_from": account["allowFrom"],
            "group_policy": account["groupPolicy"],
            "group_allow_from": account["groupAllowFrom"],
            "send_read_receipts": True,
            "text_batch_delay_seconds": 0.05,
            "text_batch_split_delay_seconds": 0.05,
            "group_sessions_per_user": False,
            "thread_sessions_per_user": False,
        },
    )


def create_adapter(config: PlatformConfig, handler: Any) -> Any:
    adapter = platform_registry.create_adapter("whatsapp", config)
    if adapter is None:
        raise RuntimeError("Hermes official WhatsApp plugin was not registered")
    adapter.set_message_handler(handler)
    return adapter


def summarize_status(status: dict[str, Any]) -> dict[str, Any]:
    events = status.get("events") if isinstance(status.get("events"), list) else []
    outbound_messages = (
        status.get("outboundMessages") if isinstance(status.get("outboundMessages"), list) else []
    )
    outbound_nodes = (
        status.get("outboundNodes") if isinstance(status.get("outboundNodes"), list) else []
    )
    return {
        "connections": status.get("connections"),
        "authorizedConnections": status.get("authorizedConnections"),
        "active": status.get("active"),
        "bundleCaptured": status.get("bundleCaptured"),
        "markerLeaks": status.get("markerLeaks"),
        "identityRejections": status.get("identityRejections"),
        "eventStages": [
            f"{event.get('stage')}:{event.get('outcome')}"
            for event in events
            if isinstance(event, dict)
        ],
        "outboundDrops": [
            {
                "reason": event.get("details", {}).get("reason", "unspecified"),
                "errorType": event.get("details", {}).get("errorType"),
            }
            for event in events
            if isinstance(event, dict)
            and event.get("stage") == "outbound_message"
            and event.get("outcome") == "dropped"
        ],
        "inboundPushCount": len(status.get("inboundPushes", [])),
        "modelRequestCount": len(status.get("modelRequests", [])),
        "outboundMessageCount": len(outbound_messages),
        "outboundNodeCount": len(outbound_nodes),
        "outboundNodeKinds": [
            f"{node.get('tag')}:{node.get('attrs', {}).get('type', '')}"
            for node in outbound_nodes
            if isinstance(node, dict)
        ],
    }


async def connected_with_bundle() -> bool:
    status = await control_status()
    return bool(status["active"] and status["bundleCaptured"])


async def hermes_inbound_reply_ready(
    received: list[dict[str, Any]], inbound: str, reply: str
) -> bool:
    status = await control_status()
    return any(message["text"] == inbound for message in received) and any(
        message.get("conversation") == reply for message in status["outboundMessages"]
    )


async def hermes_protocol_envelopes_ready() -> bool:
    status = await control_status()
    return (
        any(
            message.get("conversation") == "hermes outbound text"
            for message in status["outboundMessages"]
        )
        and any(
            any(
                node.get("tag") == "meta" and node.get("attrs", {}).get("polltype") == "creation"
                for node in message["additionalNodes"]
            )
            for message in status["outboundMessages"]
        )
        and any(node.get("tag") == "chatstate" for node in status["outboundNodes"])
        and any(node.get("tag") == "receipt" for node in status["outboundNodes"])
    )


async def connection_count_exceeds(previous: int) -> bool:
    status = await control_status()
    return bool(status["connections"] > previous and status["active"])


async def reconstructed_after_restart(previous: int) -> bool:
    status = await control_status()
    return (
        status["connections"] > previous
        and status["active"]
        and any(
            event["stage"] == "agent_bundle" and event["outcome"] == "restored"
            for event in status["events"]
        )
    )


async def assert_common_boundary(projection: dict[str, Any]) -> None:
    status = await control_status()
    assert status["authorizedConnections"] == status["connections"]
    assert status["markerLeaks"] == 0
    assert status["identityRejections"] == 0
    assert len(status["inboundPushes"]) >= 2
    assert len(status["outboundMessages"]) >= 4
    assert all(message["messageProtoBase64"] for message in status["outboundMessages"])
    creds = (Path(projection["authDir"]) / "creds.json").read_text(encoding="utf-8")
    assert "clawdi.managedWhatsAppSocket" in creds
    assert "wa-native-e2e-link-bearer" not in creds
    assert "must-not-project.invalid" not in creds


async def control_status() -> dict[str, Any]:
    return await fetch_json(f"{CONTROL_BASE}/control/status")


async def control_post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    return await fetch_json(f"{CONTROL_BASE}{path}", method="POST", body=body)


async def fetch_json(
    url: str, *, method: str = "GET", body: dict[str, Any] | None = None
) -> dict[str, Any]:
    async with aiohttp.ClientSession() as session:
        async with session.request(method, url, json=body) as response:
            text = await response.text()
            if response.status >= 400:
                raise RuntimeError(f"{url} returned {response.status}: {text}")
            value = json.loads(text)
            if not isinstance(value, dict):
                raise RuntimeError(f"{url} returned a non-object response")
            return value


async def wait_for(predicate: Any, label: str, timeout: float = 30.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    last_error: Exception | None = None
    while asyncio.get_running_loop().time() < deadline:
        try:
            if await predicate():
                return
        except Exception as exc:
            last_error = exc
        await asyncio.sleep(0.1)
    suffix = f": {last_error}" if last_error else ""
    raise RuntimeError(f"{label} timed out{suffix}")


def required_environment(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


if __name__ == "__main__":
    asyncio.run(main())
