from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import socket
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from sqlalchemy import select

from app.core.database import async_session_factory
from app.main import app
from app.models.channel import (
    CHANNEL_PROVIDER_WHATSAPP,
    MESSAGE_DIRECTION_INBOUND,
    ChannelAccount,
    ChannelBinding,
    ChannelBotAgentLink,
    ChannelDebugEvent,
    ChannelMessage,
)
from app.models.project import PROJECT_KIND_PERSONAL, Project
from app.models.session import AgentEnvironment  # noqa: F401 - register FK table
from app.models.user import User
from app.services.channels import hash_token
from app.services.whatsapp_baileys import (
    encode_buffer_json,
    load_or_create_whatsapp_auth_cert,
    mint_whatsapp_agent_credential,
    serialize_whatsapp_auth_cert,
)

pytestmark = pytest.mark.skipif(
    os.getenv("CLAWDI_RUN_BAILEYS_SMOKE") != "1",
    reason="set CLAWDI_RUN_BAILEYS_SMOKE=1 to run the real Node Baileys websocket smoke",
)


@pytest.mark.asyncio
async def test_whatsapp_baileys_websocket_reaches_open_with_real_baileys() -> None:
    baileys_cwd = _baileys_smoke_cwd()
    _assert_baileys_available(baileys_cwd)
    seeded = await _seed_whatsapp_smoke_account()
    async with _running_smoke_backend(seeded):
        result = await _run_node_baileys_smoke(baileys_cwd=baileys_cwd, seeded=seeded)
        debug_events = await _debug_events_for(seeded["account_id"])
        assert result.returncode == 0, (
            result.stdout,
            result.stderr,
            [(event["stage"], event["outcome"], event["details"]) for event in debug_events],
        )
        opened = json.loads(result.stdout)
        assert opened["status"] == "open"
        assert opened["user"]["id"] == seeded["jid"]


@pytest.mark.asyncio
async def test_whatsapp_baileys_websocket_delivers_inbox_to_real_baileys() -> None:
    baileys_cwd = _baileys_smoke_cwd()
    _assert_baileys_available(baileys_cwd)
    seeded = await _seed_whatsapp_smoke_account(include_inbox=True)
    async with _running_smoke_backend(seeded):
        result = await _run_node_baileys_smoke(baileys_cwd=baileys_cwd, seeded=seeded)
        debug_events = await _debug_events_for(seeded["account_id"])
        assert result.returncode == 0, (
            result.stdout,
            result.stderr,
            [(event["stage"], event["outcome"], event["details"]) for event in debug_events],
        )
        opened = json.loads(result.stdout)
        assert opened["status"] == "open"
        assert opened["inbound"] == seeded["expected_inbound"]
        assert ("inbound_message", "pushed") in {
            (event["stage"], event["outcome"]) for event in debug_events
        }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("inbox_payload", "expected_conversation", "expected_message_hex"),
    [
        (
            {
                "message": {
                    "extendedTextMessage": {
                        "text": "reply that quotes the base",
                        "contextInfo": {
                            "stanzaId": "3EB0CA8C2FE5219FEA4DF0",
                            "participant": "10000000001@s.whatsapp.net",
                            "quotedMessage": {
                                "extendedTextMessage": {"text": "quoted base message"},
                            },
                        },
                    },
                    "messageContextInfo": {
                        "messageSecret": ("vKvmc0ZE06OymNK0bXCMwEiS8jo/wWvZsjvfIkPbN5w="),
                    },
                },
                "pushName": "Pretend User",
                "messageTimestamp": 1_700_000_000,
            },
            "reply that quotes the base",
            "326c0a1a7265706c7920746861742071756f746573207468652062617365"
            "8a014d0a1633454230434138433246453532313946454134444630121a31"
            "3030303030303030303140732e77686174736170702e6e65741a1732150a"
            "1371756f7465642062617365206d6573736167659a02221a20bcabe67346"
            "44d3a3b298d2b46d708cc04892f23a3fc16bd9b23bdf2243db379c",
        ),
        (
            {
                "message": {
                    "imageMessage": {
                        "url": "https://mmg.whatsapp.net/o1/v/test",
                        "mimetype": "image/jpeg",
                        "caption": "tiny red dot",
                        "fileSha256": "KdcSnkLwicTqmqTyKjnU8Qfj5AxI6GMpYYddPdftzFk=",
                        "fileLength": "70",
                        "mediaKey": "8N6ORZLxSd3MHhbHAnsVAeX4ss4495v05BrZG1scD68=",
                        "fileEncSha256": "R5OoBhcXEODfbD2lAkxWLsp2r4NBfE3oFE9kfF1h0NU=",
                        "directPath": "/o1/v/test",
                        "mediaKeyTimestamp": "1776548383",
                    },
                    "messageContextInfo": {
                        "messageSecret": ("z48qzbAvo2C1mkyj8C5YlQcKC28Zk8XoygQ+1ikI5Xc="),
                    },
                },
                "pushName": "Pretend User",
                "messageTimestamp": 1_700_000_000,
            },
            None,
            "1ab8010a2268747470733a2f2f6d6d672e77686174736170702e6e65742f"
            "6f312f762f74657374120a696d6167652f6a7065671a0c74696e79207265"
            "6420646f74222029d7129e42f089c4ea9aa4f22a39d4f107e3e40c48e86"
            "32961875d3dd7edcc5928464220f0de8e4592f149ddcc1e16c7027b1501"
            "e5f8b2ce38f79bf4e41ad91b5b1c0faf4a204793a806171710e0df6c3d"
            "a5024c562eca76af83417c4de8144f647c5d61d0d55a0a2f6f312f762f74"
            "657374609ff48fcf069a02221a20cf8f2acdb02fa360b59a4ca3f02e58"
            "95070a0b6f1993c5e8ca043ed62908e577",
        ),
        (
            {
                "key": {
                    "remoteJid": "199900000000000001@g.us",
                    "participant": "10000000001@s.whatsapp.net",
                    "id": "BAILEYS-INBOUND-1",
                },
                "message": {
                    "senderKeyDistributionMessage": {
                        "groupId": "199900000000000001@g.us",
                        "axolotlSenderKeyDistributionMessage": (
                            "Mwjx7K+7BRAAGiCmflaKkWoXIi3uwdEz6NS3ILO9YvGs6EY4mFDEVpQ"
                            "BsCIhBa0TbC8zpFxWFBky2egVLSS8+BwXKemF4AZFGlj5ihsU="
                        ),
                    },
                    "extendedTextMessage": {
                        "text": "scenario 08 group from alice [1/2]",
                    },
                    "messageContextInfo": {
                        "messageSecret": ("GatUnpb8euwrXMEgWQfXdPod+T6z3F0YtfyDcOLU/jw="),
                    },
                },
                "pushName": "Pretend User",
                "messageTimestamp": 1_700_000_000,
            },
            "scenario 08 group from alice [1/2]",
            "12690a1731393939303030303030303030303030303140672e7573124e33"
            "08f1ecafbb0510001a20a67e568a916a17222deec1d133e8d4b720b3bd"
            "62f1ace846389850c4569401b0222105ad136c2f33a45c56141932d9e8"
            "152d24bcf81c1729e985e006451a58f98a1b1432240a227363656e6172"
            "696f2030382067726f75702066726f6d20616c696365205b312f325d9a"
            "02221a2019ab549e96fc7aec2b5cc1205907d774fa1df93eb3dc5d18b"
            "5fc8370e2d4fe3c",
        ),
    ],
)
async def test_whatsapp_baileys_websocket_delivers_fixture_shapes_to_real_baileys(
    inbox_payload: dict[str, Any],
    expected_conversation: str | None,
    expected_message_hex: str,
) -> None:
    baileys_cwd = _baileys_smoke_cwd()
    _assert_baileys_available(baileys_cwd)
    seeded = await _seed_whatsapp_smoke_account(
        include_inbox=True,
        inbox_payload=inbox_payload,
        expected_conversation=expected_conversation,
        expected_message_hex=expected_message_hex,
    )
    async with _running_smoke_backend(seeded):
        result = await _run_node_baileys_smoke(baileys_cwd=baileys_cwd, seeded=seeded)
        debug_events = await _debug_events_for(seeded["account_id"])
        assert result.returncode == 0, (
            result.stdout,
            result.stderr,
            [(event["stage"], event["outcome"], event["details"]) for event in debug_events],
        )
        opened = json.loads(result.stdout)
        assert opened["status"] == "open"
        assert opened["inbound"] == seeded["expected_inbound"]


@pytest.mark.asyncio
async def test_whatsapp_baileys_sidecar_reaches_open_with_fastapi_runtime() -> None:
    sidecar_cwd = Path(
        os.getenv(
            "CLAWDI_BAILEYS_SIDECAR_SMOKE_CWD",
            str(Path(__file__).resolve().parents[2] / "packages/whatsapp-baileys-sidecar"),
        )
    )
    _assert_sidecar_available(sidecar_cwd)
    seeded = await _seed_whatsapp_smoke_account()
    sidecar_port = _free_port()
    process: subprocess.Popen[str] | None = None
    with tempfile.TemporaryDirectory(prefix="clawdi-wa-sidecar-smoke-") as session_dir:
        Path(session_dir, "creds.json").write_text(json.dumps(seeded["creds"]), encoding="utf-8")
        async with _running_smoke_backend(seeded):
            try:
                process = _start_sidecar_smoke_process(
                    sidecar_cwd=sidecar_cwd,
                    session_dir=session_dir,
                    port=sidecar_port,
                    token="sidecar-smoke-token",
                    ws_url=seeded["ws_url"],
                    auth_cert=seeded["auth_cert"],
                )
                health = await _wait_for_sidecar_health(
                    port=sidecar_port,
                    token="sidecar-smoke-token",
                    process=process,
                )
                assert health["status"] == "connected"
                assert health["connected"] is True
                assert health["user"]["id"] == seeded["jid"]
            finally:
                _stop_process(process)


@contextlib.asynccontextmanager
async def _running_smoke_backend(seeded: dict[str, Any]):
    port = _free_port()
    seeded["ws_url"] = f"ws://127.0.0.1:{port}/v1/channels/whatsapp/{seeded['account_id']}/baileys"
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            lifespan="off",
        )
    )
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)
        yield
    finally:
        server.should_exit = True
        with contextlib.suppress(asyncio.CancelledError):
            await task
        await _delete_smoke_user(seeded["user_id"])


async def _run_node_baileys_smoke(
    *,
    baileys_cwd: str,
    seeded: dict[str, Any],
) -> subprocess.CompletedProcess[str]:
    return await asyncio.to_thread(
        subprocess.run,
        ["node", "--input-type=module", "-e", _NODE_BAILEYS_OPEN_SMOKE],
        input=json.dumps(seeded),
        text=True,
        cwd=baileys_cwd,
        capture_output=True,
        timeout=12,
    )


def _assert_baileys_available(cwd: str) -> None:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", "await import('baileys')"],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    if result.returncode != 0:
        pytest.skip(f"baileys package is not importable from {cwd}")


def _baileys_smoke_cwd() -> str:
    cwd = os.getenv("CLAWDI_BAILEYS_SMOKE_CWD")
    if not cwd:
        pytest.skip("set CLAWDI_BAILEYS_SMOKE_CWD to a Baileys package checkout")
    return cwd


def _assert_sidecar_available(cwd: Path) -> None:
    if not (cwd / "src/index.ts").exists():
        pytest.skip(f"Baileys sidecar package is not available at {cwd}")
    result = subprocess.run(
        ["bun", "--version"],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    if result.returncode != 0:
        pytest.skip("bun is not available for the Baileys sidecar smoke")


async def _seed_whatsapp_smoke_account(
    *,
    include_inbox: bool = False,
    inbox_payload: dict[str, Any] | None = None,
    expected_conversation: str | None = None,
    expected_message_hex: str | None = None,
) -> dict[str, Any]:
    marker = f"wa-baileys-smoke-{uuid.uuid4().hex[:10]}"
    async with async_session_factory() as db:
        user = User(
            clerk_id=marker,
            email=f"{marker}@clawdi.local",
            name="Baileys Smoke",
        )
        db.add(user)
        await db.flush()
        project = Project(
            user_id=user.id,
            name=marker,
            slug=marker,
            kind=PROJECT_KIND_PERSONAL,
        )
        db.add(project)
        await db.flush()
        agent = AgentEnvironment(
            user_id=user.id,
            machine_id=marker,
            machine_name="Baileys Smoke Agent",
            agent_type="smoke",
            os="linux",
            default_project_id=project.id,
        )
        db.add(agent)
        await db.flush()
        account = ChannelAccount(
            user_id=user.id,
            provider=CHANNEL_PROVIDER_WHATSAPP,
            name=marker,
            webhook_secret_hash=hash_token(f"{marker}-webhook"),
            config={},
        )
        db.add(account)
        await db.flush()
        link = ChannelBotAgentLink(
            account_id=account.id,
            user_id=user.id,
            agent_id=agent.id,
            agent_token_hash=hash_token(f"{marker}-agent"),
        )
        db.add(link)
        await db.flush()
        auth_cert = await load_or_create_whatsapp_auth_cert(db, account=account)
        stored = await mint_whatsapp_agent_credential(
            db,
            account=account,
            bot_agent_link_id=link.id,
            phone_user="15551234567",
            device=7,
            name="clawdi smoke tenant",
            self_identity={
                "id": "15551234567:7@s.whatsapp.net",
                "lid": "900000000000001:7@lid",
            },
        )
        expected_inbound: dict[str, Any] | None = None
        if include_inbox:
            provider_message_id = "BAILEYS-INBOUND-1"
            body = expected_conversation
            if inbox_payload is None and body is None:
                body = "ping from clawdi inbox"
            payload_remote_jid = None
            if isinstance(inbox_payload, dict):
                key = inbox_payload.get("key")
                if isinstance(key, dict):
                    remote_jid = key.get("remoteJid")
                    payload_remote_jid = remote_jid if isinstance(remote_jid, str) else None
            provider_jid = (
                payload_remote_jid or f"1555{uuid.uuid4().int % 10_000_000:07d}@s.whatsapp.net"
            )
            payload = inbox_payload or {
                "key": {"remoteJid": provider_jid, "id": provider_message_id},
                "message": {"conversation": body},
                "pushName": "Pretend User",
                "messageTimestamp": 1_700_000_000,
            }
            payload.setdefault("key", {"remoteJid": provider_jid, "id": provider_message_id})
            key = payload.get("key")
            if isinstance(key, dict):
                key.setdefault("remoteJid", provider_jid)
                key.setdefault("id", provider_message_id)
            payload.setdefault("pushName", "Pretend User")
            payload.setdefault("messageTimestamp", 1_700_000_000)
            binding = ChannelBinding(
                account_id=account.id,
                bot_agent_link_id=link.id,
                user_id=user.id,
                external_chat_id=provider_jid,
                external_chat_type="private",
                external_chat_name="Pretend User",
            )
            db.add(binding)
            await db.flush()
            db.add(
                ChannelMessage(
                    account_id=account.id,
                    bot_agent_link_id=link.id,
                    binding_id=binding.id,
                    user_id=user.id,
                    direction=MESSAGE_DIRECTION_INBOUND,
                    external_chat_id=provider_jid,
                    provider_message_id=provider_message_id,
                    text=body,
                    payload=payload,
                )
            )
            expected_inbound = {
                "remoteJid": provider_jid,
                "id": provider_message_id,
                "pushName": "Pretend User",
                "conversation": body,
            }
            if expected_message_hex is not None:
                expected_inbound["messageHex"] = expected_message_hex
        await db.commit()
        seeded: dict[str, Any] = {
            "user_id": str(user.id),
            "account_id": str(account.id),
            "jid": stored.minted.jid,
            "creds": encode_buffer_json(stored.minted.creds),
            "auth_cert": serialize_whatsapp_auth_cert(auth_cert),
        }
        if expected_inbound is not None:
            seeded["expected_inbound"] = expected_inbound
        return seeded


async def _delete_smoke_user(user_id: str) -> None:
    async with async_session_factory() as db:
        user = await db.get(User, uuid.UUID(user_id))
        if user is not None:
            await db.delete(user)
            await db.commit()


async def _debug_events_for(account_id: str) -> list[dict[str, Any]]:
    async with async_session_factory() as db:
        result = await db.execute(
            select(ChannelDebugEvent)
            .where(ChannelDebugEvent.account_id == uuid.UUID(account_id))
            .order_by(ChannelDebugEvent.created_at.asc(), ChannelDebugEvent.id.asc())
        )
        return [
            {
                "stage": event.stage,
                "outcome": event.outcome,
                "details": event.details,
            }
            for event in result.scalars().all()
        ]


def _start_sidecar_smoke_process(
    *,
    sidecar_cwd: Path,
    session_dir: str,
    port: int,
    token: str,
    ws_url: str,
    auth_cert: dict[str, Any],
) -> subprocess.Popen[str]:
    public_key = _buffer_json_to_bytes(auth_cert["PUBLIC_KEY"])
    env = {
        **os.environ,
        "CLAWDI_WA_SIDECAR_TOKEN": token,
        "CLAWDI_WA_SIDECAR_SESSION_DIR": session_dir,
        "CLAWDI_WA_SIDECAR_HOST": "127.0.0.1",
        "CLAWDI_WA_SIDECAR_PORT": str(port),
        "CLAWDI_WA_WEBSOCKET_URL": ws_url,
        "CLAWDI_WA_AUTH_CERT_SERIAL": str(auth_cert["SERIAL"]),
        "CLAWDI_WA_AUTH_CERT_ISSUER": str(auth_cert["ISSUER"]),
        "CLAWDI_WA_AUTH_CERT_PUBKEY_BASE64": base64.b64encode(public_key).decode("ascii"),
        "CLAWDI_WA_SIDECAR_LOG_LEVEL": "silent",
    }
    return subprocess.Popen(
        ["bun", "run", "src/index.ts"],
        cwd=sidecar_cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


async def _wait_for_sidecar_health(
    *,
    port: int,
    token: str,
    process: subprocess.Popen[str],
) -> dict[str, Any]:
    url = f"http://127.0.0.1:{port}/v1/health"
    async with httpx.AsyncClient(timeout=1.0) as client:
        for _ in range(160):
            if process.poll() is not None:
                stdout, stderr = process.communicate(timeout=2)
                raise AssertionError(
                    f"sidecar exited early with {process.returncode}\n"
                    f"stdout={stdout}\nstderr={stderr}"
                )
            try:
                response = await client.get(url, headers={"Authorization": f"Bearer {token}"})
            except httpx.HTTPError:
                await asyncio.sleep(0.05)
                continue
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, dict) and data.get("connected") is True:
                    return data
            await asyncio.sleep(0.05)
    stdout, stderr = _process_output(process)
    raise AssertionError(f"sidecar did not connect\nstdout={stdout}\nstderr={stderr}")


def _buffer_json_to_bytes(value: Any) -> bytes:
    if not isinstance(value, dict) or value.get("type") != "Buffer":
        raise AssertionError(f"expected BufferJSON public key, got {value!r}")
    data = value.get("data")
    if isinstance(data, str):
        return base64.b64decode(data)
    if not isinstance(data, list):
        raise AssertionError(f"expected BufferJSON data list or base64 string, got {value!r}")
    return bytes(int(part) for part in data)


def _stop_process(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.communicate(timeout=3)
        return
    process.kill()
    process.communicate(timeout=3)


def _process_output(process: subprocess.Popen[str]) -> tuple[str, str]:
    if process.poll() is None:
        return ("", "")
    return process.communicate(timeout=2)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


_NODE_BAILEYS_OPEN_SMOKE = r"""
import { makeWASocket, Browsers, proto } from "baileys";
import { BufferJSON } from "baileys/lib/Utils/generics.js";

const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => data += chunk);
  process.stdin.on("end", () => resolve(JSON.parse(data)));
});
const creds = JSON.parse(JSON.stringify(input.creds), BufferJSON.reviver);
const silentLogger = {
  level: "silent",
  child: () => silentLogger,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};
class InMemorySignalKeyStore {
  data = new Map();
  async get(type, ids) {
    const bucket = this.data.get(type) ?? new Map();
    const out = {};
    for (const id of ids) {
      if (bucket.has(id)) out[id] = bucket.get(id);
    }
    return out;
  }
  async set(data) {
    for (const [type, items] of Object.entries(data ?? {})) {
      let bucket = this.data.get(type);
      if (!bucket) this.data.set(type, bucket = new Map());
      for (const [id, value] of Object.entries(items ?? {})) {
        if (value === null || value === undefined) bucket.delete(id);
        else bucket.set(id, value);
      }
    }
  }
  async clear() {
    this.data.clear();
  }
}
const sock = makeWASocket({
  auth: { creds, keys: new InMemorySignalKeyStore() },
  logger: silentLogger,
  browser: Browsers.appropriate("clawdi python smoke"),
  printQRInTerminal: false,
  waWebSocketUrl: input.ws_url,
  authCert: input.auth_cert,
  syncFullHistory: false,
  connectTimeoutMs: 5000,
});
const result = await new Promise((resolve) => {
  let openedUser = null;
  let inbound = null;
  let resolved = false;
  const done = (value) => {
    if (resolved) return;
    resolved = true;
    clearTimeout(timer);
    resolve(value);
  };
  const maybeDone = () => {
    if (openedUser && (!input.expected_inbound || inbound)) {
      done({ status: "open", user: openedUser, inbound });
    }
  };
  const timer = setTimeout(() => done({ status: "timeout", inbound }), 8000);
  sock.ev.on("connection.update", (update) => {
    if (update.connection === "open") {
      openedUser = sock.user;
      maybeDone();
    } else if (update.connection === "close") {
      done({ status: "close", close: update.lastDisconnect, inbound });
    }
  });
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const message of messages) {
      const conversation =
        message.message?.conversation ?? message.message?.extendedTextMessage?.text ?? null;
      if (
        input.expected_inbound &&
        message.key?.remoteJid === input.expected_inbound.remoteJid &&
        message.key?.id === input.expected_inbound.id
      ) {
        inbound = {
          remoteJid: message.key.remoteJid,
          id: message.key.id,
          pushName: message.pushName ?? null,
          conversation,
        };
        if (input.expected_inbound.messageHex) {
          inbound.messageHex = message.message
            ? Buffer.from(proto.Message.encode(message.message).finish()).toString("hex")
            : null;
        }
        maybeDone();
        return;
      }
    }
  });
});
try {
  sock.end(undefined);
} catch {}
console.log(JSON.stringify(result));
process.exit(result.status === "open" ? 0 : 2);
"""
