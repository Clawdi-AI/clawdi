from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
import websockets
from sqlalchemy import select

from app.core.database import async_session_factory
from app.models.project import PROJECT_KIND_ENVIRONMENT, Project
from app.models.session import AgentEnvironment
from app.models.user import User

pytestmark = pytest.mark.skipif(
    os.getenv("CLAWDI_RUN_CHANNELS_BLACKBOX_E2E") != "1",
    reason="set CLAWDI_RUN_CHANNELS_BLACKBOX_E2E=1 to run network blackbox channel e2e",
)


BACKEND_ROOT = Path(__file__).resolve().parents[2]
DEV_AUTH_TOKEN = "channels-blackbox-e2e-token"


@dataclass
class RunningBackend:
    base_url: str
    auth_headers: dict[str, str]
    clerk_id: str
    process: subprocess.Popen[bytes]
    log_path: Path


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _start_backend() -> RunningBackend:
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"
    run_id = uuid.uuid4().hex[:12]
    log_file = tempfile.NamedTemporaryFile(
        prefix="clawdi-channels-blackbox-e2e-",
        suffix=".log",
        delete=False,
    )
    log_path = Path(log_file.name)
    env = os.environ.copy()
    clerk_id = f"channels_blackbox_{run_id}"
    env.update(
        {
            "ENVIRONMENT": "development",
            "DEV_AUTH_BYPASS": "true",
            "DEV_AUTH_TOKEN": DEV_AUTH_TOKEN,
            "DEV_AUTH_CLERK_ID": clerk_id,
            "DEV_AUTH_EMAIL": f"channels-blackbox-{run_id}@clawdi.local",
            "DEV_AUTH_NAME": "Channels Blackbox E2E",
            "MEMORY_EMBEDDING_MODE": "disabled",
            "PUBLIC_API_URL": base_url,
            "VAULT_ENCRYPTION_KEY": secrets.token_hex(32),
            "ENCRYPTION_KEY": secrets.token_hex(32),
            "CHANNEL_LONG_POLL_MAX_SECONDS": "0.2",
            "CHANNEL_LONG_POLL_INTERVAL_SECONDS": "0.01",
            "DISCORD_GATEWAY_POLL_INTERVAL_SECONDS": "0.01",
            "PYTHONUNBUFFERED": "1",
        }
    )
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "info",
        ],
        cwd=BACKEND_ROOT,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    log_file.close()
    backend = RunningBackend(
        base_url=base_url,
        auth_headers={"Authorization": f"Bearer {DEV_AUTH_TOKEN}"},
        clerk_id=clerk_id,
        process=process,
        log_path=log_path,
    )
    try:
        await _wait_for_health(backend)
    except Exception:
        await _stop_backend(backend, keep_log=True)
        raise
    return backend


async def _wait_for_health(backend: RunningBackend) -> None:
    deadline = asyncio.get_running_loop().time() + 20
    last_error = ""
    async with httpx.AsyncClient(base_url=backend.base_url, timeout=2.0) as client:
        while asyncio.get_running_loop().time() < deadline:
            if backend.process.poll() is not None:
                raise AssertionError(
                    "backend exited during startup\n" + _backend_logs(backend)
                )
            try:
                response = await client.get("/health")
                if response.status_code == 200 and response.json().get("status") == "ok":
                    return
                last_error = f"status={response.status_code} body={response.text[:500]}"
            except (httpx.HTTPError, ValueError) as exc:
                last_error = repr(exc)
            await asyncio.sleep(0.2)
    raise AssertionError(f"backend did not become healthy: {last_error}\n{_backend_logs(backend)}")


async def _stop_backend(backend: RunningBackend, *, keep_log: bool = False) -> None:
    if backend.process.poll() is None:
        backend.process.terminate()
        try:
            await asyncio.to_thread(backend.process.wait, 5)
        except subprocess.TimeoutExpired:
            backend.process.kill()
            await asyncio.to_thread(backend.process.wait, 5)
    if not keep_log:
        backend.log_path.unlink(missing_ok=True)


def _backend_logs(backend: RunningBackend) -> str:
    try:
        raw = backend.log_path.read_text(errors="replace")
    except OSError as exc:
        return f"<could not read backend log: {exc}>"
    return raw[-6000:]


async def _ensure_blackbox_agent(backend: RunningBackend) -> None:
    async with async_session_factory() as db:
        user = (
            await db.execute(select(User).where(User.clerk_id == backend.clerk_id))
        ).scalar_one()
        slug = f"blackbox-agent-{uuid.uuid4().hex[:12]}"
        project = Project(
            user_id=user.id,
            name="Channels Blackbox Agent",
            slug=slug,
            kind=PROJECT_KIND_ENVIRONMENT,
        )
        db.add(project)
        await db.flush()
        db.add(
            AgentEnvironment(
                user_id=user.id,
                machine_id=slug,
                machine_name="Channels Blackbox Agent",
                agent_type="blackbox",
                os="linux",
                default_project_id=project.id,
            )
        )
        await db.commit()


async def _request_json(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    *,
    expected: int = 200,
    **kwargs: Any,
) -> dict[str, Any]:
    response = await client.request(method, path, **kwargs)
    assert response.status_code == expected, response.text
    if response.status_code == 204:
        return {}
    payload = response.json()
    assert isinstance(payload, dict), payload
    return payload


async def _create_channel(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    provider: str,
    *,
    name: str,
    config: dict[str, Any] | None = None,
    provider_token: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"provider": provider, "name": name}
    if config is not None:
        body["config"] = config
    if provider_token is not None:
        body["provider_token"] = provider_token
    created = await _request_json(
        client,
        "POST",
        "/api/channels",
        expected=201,
        headers=headers,
        json=body,
    )
    assert created["provider"] == provider
    assert created["webhook_url"].startswith(f"{str(client.base_url).rstrip('/')}/api/channels/")
    assert created["webhook_secret"]
    assert created["agent_token"]
    return created


async def _pair_telegram(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    account: dict[str, Any],
    *,
    chat_id: int,
    run_id: str,
) -> None:
    pair = await _request_json(
        client,
        "POST",
        f"/api/channels/{account['id']}/pair-codes",
        expected=201,
        headers=headers,
        json={"ttl_seconds": 900},
    )
    paired = await _request_json(
        client,
        "POST",
        f"/api/channels/telegram/{account['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": account["webhook_secret"]},
        json={
            "update_id": 10,
            "message": {
                "message_id": 10,
                "text": f"/bot_pair {pair['code']}",
                "chat": {"id": chat_id, "type": "private"},
            },
        },
    )
    assert paired["paired"] is True
    inbound = await _request_json(
        client,
        "POST",
        f"/api/channels/telegram/{account['id']}/webhook",
        headers={"x-telegram-bot-api-secret-token": account["webhook_secret"]},
        json={
            "update_id": 11,
            "message": {
                "message_id": 11,
                "text": f"telegram hello {run_id}",
                "chat": {"id": chat_id, "type": "private"},
            },
        },
    )
    assert inbound["binding_id"]


async def _pair_discord(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    account: dict[str, Any],
    *,
    guild_id: str,
    channel_id: str,
    run_id: str,
) -> None:
    pair = await _request_json(
        client,
        "POST",
        f"/api/channels/{account['id']}/pair-codes",
        expected=201,
        headers=headers,
        json={"ttl_seconds": 900},
    )
    paired = await _request_json(
        client,
        "POST",
        f"/api/channels/discord/{account['id']}/webhook",
        headers={"x-clawdi-channel-secret": account["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": f"discord-pair-{run_id}",
                "channel_id": channel_id,
                "guild_id": guild_id,
                "content": f"/bot_pair {pair['code']}",
                "author": {"id": f"discord-user-{run_id}"},
            },
        },
    )
    assert paired["paired"] is True
    inbound = await _request_json(
        client,
        "POST",
        f"/api/channels/discord/{account['id']}/webhook",
        headers={"x-clawdi-channel-secret": account["webhook_secret"]},
        json={
            "t": "MESSAGE_CREATE",
            "d": {
                "id": f"discord-message-{run_id}",
                "channel_id": channel_id,
                "guild_id": guild_id,
                "content": f"discord hello {run_id}",
            },
        },
    )
    assert inbound["binding_id"]


async def _pair_imessage(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    account: dict[str, Any],
    *,
    chat_guid: str,
    run_id: str,
) -> None:
    pair = await _request_json(
        client,
        "POST",
        f"/api/channels/{account['id']}/pair-codes",
        expected=201,
        headers=headers,
        json={"ttl_seconds": 900},
    )
    paired = await _request_json(
        client,
        "POST",
        f"/api/channels/imessage/{account['id']}/webhook",
        params={"secret": account["webhook_secret"]},
        json={
            "data": {
                "guid": f"imessage-pair-{run_id}",
                "text": f"/bot_pair {pair['code']}",
                "chats": [{"guid": chat_guid, "displayName": "E2E"}],
            }
        },
    )
    assert paired["paired"] is True


async def _pair_whatsapp(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    account: dict[str, Any],
    *,
    phone: str,
    run_id: str,
) -> None:
    pair = await _request_json(
        client,
        "POST",
        f"/api/channels/{account['id']}/pair-codes",
        expected=201,
        headers=headers,
        json={"ttl_seconds": 900},
    )
    paired = await _request_json(
        client,
        "POST",
        f"/api/channels/whatsapp/{account['id']}/webhook",
        headers={"x-clawdi-channel-secret": account["webhook_secret"]},
        json={
            "entry": [
                {
                    "changes": [
                        {
                            "value": {
                                "messages": [
                                    {
                                        "id": f"wamid-pair-{run_id}",
                                        "from": phone,
                                        "text": {"body": f"/bot_pair {pair['code']}"},
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        },
    )
    assert paired["paired"] is True


async def _assert_discord_gateway(
    *,
    gateway_url: str,
    token: str,
    guild_id: str,
    channel_id: str,
    run_id: str,
) -> None:
    async with websockets.connect(gateway_url, open_timeout=5, close_timeout=1) as websocket:
        hello = json.loads(await asyncio.wait_for(websocket.recv(), timeout=5))
        assert hello["op"] == 10
        await websocket.send(json.dumps({"op": 2, "d": {"token": token, "intents": 513}}))

        seen_ready = False
        seen_guild = False
        seen_message = False
        deadline = asyncio.get_running_loop().time() + 5
        while asyncio.get_running_loop().time() < deadline:
            frame = json.loads(await asyncio.wait_for(websocket.recv(), timeout=5))
            if frame.get("t") == "READY":
                seen_ready = True
                assert {"id": guild_id, "unavailable": False} in frame["d"]["guilds"]
            if frame.get("t") == "GUILD_CREATE":
                seen_guild = seen_guild or frame["d"]["id"] == guild_id
            if frame.get("t") == "MESSAGE_CREATE":
                payload = frame["d"]
                if payload.get("content") == f"discord hello {run_id}":
                    assert payload["guild_id"] == guild_id
                    assert payload["channel_id"] == channel_id
                    seen_message = True
                    break
        assert seen_ready
        assert seen_guild
        assert seen_message


@pytest.mark.asyncio
async def test_channels_native_backend_blackbox_e2e() -> None:
    backend = await _start_backend()
    account_ids: list[str] = []
    passed = False
    cleanup_ok = False
    try:
        run_id = uuid.uuid4().hex[:8]
        async with httpx.AsyncClient(base_url=backend.base_url, timeout=10.0) as client:
            assert (await client.get("/health")).json() == {"status": "ok"}

            initial = await client.get("/api/channels", headers=backend.auth_headers)
            assert initial.status_code == 200, initial.text
            assert initial.json() == []
            await _ensure_blackbox_agent(backend)

            telegram = await _create_channel(
                client,
                backend.auth_headers,
                "telegram",
                name=f"e2e-telegram-{run_id}",
                config={"bot_username": f"e2e_bot_{run_id}"},
            )
            discord = await _create_channel(
                client,
                backend.auth_headers,
                "discord",
                name=f"e2e-discord-{run_id}",
                config={"application_id": f"999000{run_id[:6]}"},
            )
            imessage = await _create_channel(
                client,
                backend.auth_headers,
                "imessage",
                name=f"e2e-imessage-{run_id}",
                config={"os_version": "15.0"},
            )
            whatsapp = await _create_channel(
                client,
                backend.auth_headers,
                "whatsapp",
                name=f"e2e-whatsapp-{run_id}",
                config={"phone_number_id": f"phone-{run_id}"},
            )
            account_ids.extend([telegram["id"], discord["id"], imessage["id"], whatsapp["id"]])

            legacy_tg = await client.get(f"/bot{telegram['agent_token']}/getMe")
            assert legacy_tg.status_code == 404
            legacy_discord = await client.get(
                "/api/v10/gateway/bot",
                headers={"Authorization": f"Bot {discord['agent_token']}"},
            )
            assert legacy_discord.status_code == 404
            legacy_bluebubbles = await client.get(
                "/api/v1/server/info",
                headers={"X-API-Key": imessage["agent_token"]},
            )
            assert legacy_bluebubbles.status_code == 404

            telegram_chat_id = 880000 + int(run_id[:4], 16) % 10_000
            discord_guild_id = f"guild-{run_id}"
            discord_channel_id = f"chan-{run_id}"
            imessage_chat_guid = f"iMessage;-;+1555{int(run_id[:6], 16) % 1_000_000:06d}"
            whatsapp_phone = f"1555{int(run_id[:6], 16) % 1_000_000:06d}"

            await _pair_telegram(
                client,
                backend.auth_headers,
                telegram,
                chat_id=telegram_chat_id,
                run_id=run_id,
            )
            await _pair_discord(
                client,
                backend.auth_headers,
                discord,
                guild_id=discord_guild_id,
                channel_id=discord_channel_id,
                run_id=run_id,
            )
            await _pair_imessage(
                client,
                backend.auth_headers,
                imessage,
                chat_guid=imessage_chat_guid,
                run_id=run_id,
            )
            await _pair_whatsapp(
                client,
                backend.auth_headers,
                whatsapp,
                phone=whatsapp_phone,
                run_id=run_id,
            )

            bindings = await client.get(
                f"/api/channels/{telegram['id']}/bindings",
                headers=backend.auth_headers,
            )
            assert bindings.status_code == 200, bindings.text
            assert bindings.json()[0]["external_chat_id"] == str(telegram_chat_id)

            tg_me = await _request_json(
                client,
                "GET",
                f"/api/channels/telegram/bot/{telegram['agent_token']}/getMe",
            )
            assert tg_me["ok"] is True
            assert tg_me["result"]["username"] == f"e2e_bot_{run_id}"

            tg_updates = await _request_json(
                client,
                "GET",
                f"/api/channels/telegram/bot/{telegram['agent_token']}/getUpdates",
                params={"offset": 11, "timeout": 0},
            )
            assert tg_updates["ok"] is True
            assert tg_updates["result"] == [
                {
                    "update_id": 11,
                    "message": {
                        "message_id": 11,
                        "text": f"telegram hello {run_id}",
                        "chat": {"id": telegram_chat_id, "type": "private"},
                    },
                }
            ]

            outbox = await _request_json(
                client,
                "POST",
                f"/api/channels/{telegram['id']}/messages",
                expected=201,
                headers=backend.auth_headers,
                json={"external_chat_id": str(telegram_chat_id), "text": f"outbox {run_id}"},
            )
            assert outbox["direction"] == "outbound"
            assert outbox["delivery_status"] == "pending"

            discord_headers = {"Authorization": f"Bot {discord['agent_token']}"}
            gateway = await _request_json(
                client,
                "GET",
                "/api/channels/discord/v10/gateway/bot",
                headers=discord_headers,
            )
            assert gateway["url"] == f"ws://127.0.0.1:{client.base_url.port}/api/channels/discord/gateway"
            discord_me = await _request_json(
                client,
                "GET",
                "/api/channels/discord/v10/users/@me",
                headers=discord_headers,
            )
            assert discord_me["bot"] is True
            await _assert_discord_gateway(
                gateway_url=gateway["url"],
                token=discord["agent_token"],
                guild_id=discord_guild_id,
                channel_id=discord_channel_id,
                run_id=run_id,
            )

            bluebubbles = await _request_json(
                client,
                "GET",
                "/api/channels/imessage/bluebubbles/v1/server/info",
                headers={"X-API-Key": imessage["agent_token"]},
            )
            assert bluebubbles["data"]["private_api"] is True
            assert bluebubbles["data"]["server_version"] == "clawdi"

            wa_creds = await _request_json(
                client,
                "POST",
                f"/api/channels/whatsapp/{whatsapp['id']}/tenant-creds",
                expected=201,
                headers=backend.auth_headers,
                json={"phone_user": whatsapp_phone, "name": f"wa-{run_id}"},
            )
            assert wa_creds["jid"].endswith("@s.whatsapp.net")
            assert wa_creds["auth_cert"]["ISSUER"] == "clawdi"
            wa_cert = await _request_json(
                client,
                "GET",
                f"/api/channels/whatsapp/{whatsapp['id']}/auth-cert",
                headers=backend.auth_headers,
            )
            assert wa_cert == wa_creds["auth_cert"]

            debug_health = await _request_json(
                client,
                "GET",
                "/api/channels/debug/health",
                headers=backend.auth_headers,
            )
            providers = {entry["provider"] for entry in debug_health["channels"]}
            assert {"telegram", "discord", "whatsapp", "imessage"}.issubset(providers)
            passed = True
    finally:
        try:
            if account_ids:
                async with httpx.AsyncClient(base_url=backend.base_url, timeout=10.0) as client:
                    for account_id in account_ids:
                        await client.delete(
                            f"/api/channels/{account_id}",
                            headers=backend.auth_headers,
                        )
            cleanup_ok = True
        finally:
            await _stop_backend(backend, keep_log=not (passed and cleanup_ok))
