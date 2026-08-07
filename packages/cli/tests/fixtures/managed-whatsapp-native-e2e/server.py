from __future__ import annotations

import argparse
import asyncio
import base64
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.whatsapp_baileys import (
    WhatsAppAuthCert,
    encode_buffer_json,
    mint_whatsapp_synthetic_creds,
    whatsapp_text_message_proto,
)
from app.services.whatsapp_noise import (
    WhatsAppNoiseEmulatorSession,
    WhatsAppNoiseRuntimeEvent,
    WhatsAppNoiseTenant,
    encode_binary_node_minimal,
    generate_key_pair,
)
from app.services.whatsapp_runtime_types import WhatsAppOutboundMessage

CAPABILITY_HEADER = "x-clawdi-whatsapp-link-capability"
EXPECTED_BEARER = "wa-native-e2e-link-bearer"
SYNTHETIC_JID = "16693773518:2@s.whatsapp.net"
SYNTHETIC_LID = "900000000000001:7@lid"
INBOUND_JID = "15551112222@s.whatsapp.net"
INBOUND_LID = "184207372460253@lid"


class PushRequest(BaseModel):
    message_id: str = Field(min_length=1, max_length=128)
    text: str = Field(min_length=1, max_length=4_096)


class HarnessState:
    def __init__(self, scenario: dict[str, Any]) -> None:
        self.cert = _decode_cert(scenario["cert"])
        self.expected_identity_public = base64.b64decode(scenario["identityPublicBase64"])
        self.connections = 0
        self.authorized_connections = 0
        self.marker_leaks = 0
        self.identity_rejections = 0
        self.events: list[dict[str, Any]] = []
        self.outbound_messages: list[dict[str, Any]] = []
        self.outbound_nodes: list[dict[str, Any]] = []
        self.inbound_pushes: list[dict[str, Any]] = []
        self.model_requests: list[dict[str, Any]] = []
        self.bundle = None
        self.signal_senders = None
        self.group_sender_keys = None
        self.websocket: WebSocket | None = None
        self.session: WhatsAppNoiseEmulatorSession | None = None
        self.send_lock = asyncio.Lock()

    async def send_frame(self, websocket: WebSocket, frame: bytes) -> None:
        async with self.send_lock:
            await websocket.send_bytes(frame)

    async def resolve_client(self, identity_public: bytes) -> WhatsAppNoiseTenant | None:
        if identity_public != self.expected_identity_public:
            self.identity_rejections += 1
            return None
        return WhatsAppNoiseTenant(
            tenant_id="native-e2e-link",
            lid=SYNTHETIC_LID,
            bundle=self.bundle,
            signal_senders=self.signal_senders,
            group_sender_keys=self.group_sender_keys,
        )

    def record_event(self, event: WhatsAppNoiseRuntimeEvent) -> None:
        self.events.append(asdict(event))

    def record_outbound_message(self, message: WhatsAppOutboundMessage) -> None:
        self.outbound_messages.append(
            {
                "toJid": message.to_jid,
                "messageId": message.message_id,
                "messageProtoBase64": base64.b64encode(message.message_proto).decode("ascii"),
                "conversation": message.conversation,
                "encType": message.enc_type,
                "attrs": message.attrs,
                "additionalNodes": encode_buffer_json(list(message.additional_nodes)),
            }
        )

    def record_outbound_node(self, node: dict[str, Any], _lookup: object) -> None:
        self.outbound_nodes.append(encode_buffer_json(node))

    def persist_session_state(self) -> None:
        if self.session is None:
            return
        if self.session.bundle is not None:
            self.bundle = self.session.bundle
        self.signal_senders = self.session.signal_sender_snapshots()
        self.group_sender_keys = self.session.group_sender_key_snapshots()

    def status(self) -> dict[str, Any]:
        return {
            "connections": self.connections,
            "authorizedConnections": self.authorized_connections,
            "markerLeaks": self.marker_leaks,
            "identityRejections": self.identity_rejections,
            "active": self.websocket is not None and self.session is not None,
            "bundleCaptured": self.bundle is not None,
            "events": self.events,
            "outboundMessages": self.outbound_messages,
            "outboundNodes": self.outbound_nodes,
            "inboundPushes": self.inbound_pushes,
            "modelRequests": self.model_requests,
        }


def create_app(state: HarnessState) -> FastAPI:
    app = FastAPI()

    @app.websocket("/v1/channels/whatsapp/baileys")
    async def baileys(websocket: WebSocket) -> None:
        authorization = websocket.headers.get("authorization")
        if authorization != f"Bearer {EXPECTED_BEARER}":
            await websocket.close(code=4401)
            return
        if websocket.headers.get(CAPABILITY_HEADER) is not None:
            state.marker_leaks += 1
            await websocket.close(code=4403)
            return

        await websocket.accept()
        state.connections += 1
        state.authorized_connections += 1
        session = WhatsAppNoiseEmulatorSession(
            auth_cert=state.cert,
            lid=SYNTHETIC_LID,
            resolve_client=state.resolve_client,
            on_event=state.record_event,
            on_outbound_message=state.record_outbound_message,
            on_outbound_relay=state.record_outbound_node,
            resolve_recipient_lid=lambda jid: (
                INBOUND_LID
                if jid.split("@", 1)[0].split(":", 1)[0]
                in {
                    INBOUND_JID.split("@", 1)[0],
                    INBOUND_LID.split("@", 1)[0],
                }
                else None
            ),
        )
        state.websocket = websocket
        state.session = session
        try:
            while True:
                chunk = await websocket.receive_bytes()
                for frame in await session.handle_inbound(chunk):
                    await state.send_frame(websocket, frame)
                state.persist_session_state()
        except WebSocketDisconnect:
            pass
        finally:
            state.persist_session_state()
            if state.websocket is websocket:
                state.websocket = None
                state.session = None

    @app.get("/control/status")
    async def status() -> dict[str, Any]:
        return state.status()

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [{"id": "native-e2e", "object": "model", "owned_by": "clawdi-e2e"}],
        }

    @app.post("/v1/chat/completions", response_model=None)
    async def chat_completions(request: Request) -> StreamingResponse | dict[str, Any]:
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="request body must be an object")
        state.model_requests.append(payload)
        serialized = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        content = (
            "openclaw agent reply after reconnect"
            if "after 515" in serialized
            else "openclaw agent reply"
        )
        if payload.get("stream") is not True:
            return {
                "id": f"chatcmpl-native-e2e-{len(state.model_requests)}",
                "object": "chat.completion",
                "created": 0,
                "model": "native-e2e",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            }

        async def events():
            completion_id = f"chatcmpl-native-e2e-{len(state.model_requests)}"
            yield _sse_chunk(completion_id, {"role": "assistant", "content": ""}, None)
            await asyncio.sleep(0.25)
            yield _sse_chunk(completion_id, {"content": content}, None)
            yield _sse_chunk(completion_id, {}, "stop")
            yield "data: [DONE]\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.post("/control/push")
    async def push(request: PushRequest) -> dict[str, Any]:
        if state.websocket is None or state.session is None:
            raise HTTPException(status_code=409, detail="synthetic socket is not connected")
        proto = whatsapp_text_message_proto(request.text)
        try:
            frame, result = await state.session.push_inbound_message(
                from_jid=INBOUND_JID,
                message_id=request.message_id,
                message_proto=proto,
                push_name="Native E2E",
                sender_lid_jid=INBOUND_LID,
                sender_pn_jid=INBOUND_JID,
            )
            await state.send_frame(state.websocket, frame)
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(status_code=409, detail="synthetic socket is not ready") from exc
        state.persist_session_state()
        record = {
            "messageId": result.message_id,
            "messageProtoBase64": base64.b64encode(proto).decode("ascii"),
            "text": request.text,
        }
        state.inbound_pushes.append(record)
        return record

    @app.post("/control/restart")
    async def restart() -> dict[str, bool]:
        if state.websocket is None or state.session is None:
            raise HTTPException(status_code=409, detail="synthetic socket is not connected")
        node = {
            "tag": "stream:error",
            "attrs": {"code": "515"},
            "content": [{"tag": "restart", "attrs": {}}],
        }
        # The encrypted 515 frame is intentionally test-only. Product code owns
        # no consumer-specific reconnect adapter or synthetic application API.
        frame = state.session._noise.encrypt_frame(encode_binary_node_minimal(node))
        await state.send_frame(state.websocket, frame)
        return {"sent": True}

    return app


def _sse_chunk(completion_id: str, delta: dict[str, str], finish_reason: str | None) -> str:
    payload = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "native-e2e",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


def init_scenario(path: Path) -> None:
    root = generate_key_pair()
    intermediate = generate_key_pair()
    cert = WhatsAppAuthCert(
        serial=7,
        issuer="clawdi",
        root_public_key=root.public,
        root_private_key=root.private,
        intermediate_public_key=intermediate.public,
        intermediate_private_key=intermediate.private,
    )
    minted = mint_whatsapp_synthetic_creds(
        tenant_id="native-e2e-link",
        self_identity={"id": SYNTHETIC_JID, "lid": SYNTHETIC_LID, "name": "Native E2E"},
    )
    scenario = {
        "cert": _encode_cert(cert),
        "identityPublicBase64": base64.b64encode(minted.identity_pub_key).decode("ascii"),
        "channelMaterial": {
            "schemaVersion": "clawdi.whatsappBaileysAuthState.v1",
            "creds": encode_buffer_json(minted.creds),
            "websocketUrl": "wss://must-not-project.invalid/ws",
            "authCert": {
                "SERIAL": cert.serial,
                "ISSUER": cert.issuer,
                "PUBLIC_KEY": {
                    "type": "Buffer",
                    "data": base64.b64encode(cert.root_public_key).decode("ascii"),
                },
            },
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(scenario, separators=(",", ":")), encoding="utf-8")


def _encode_cert(cert: WhatsAppAuthCert) -> dict[str, Any]:
    return {
        "serial": cert.serial,
        "issuer": cert.issuer,
        "rootPublic": base64.b64encode(cert.root_public_key).decode("ascii"),
        "rootPrivate": base64.b64encode(cert.root_private_key).decode("ascii"),
        "intermediatePublic": base64.b64encode(cert.intermediate_public_key).decode("ascii"),
        "intermediatePrivate": base64.b64encode(cert.intermediate_private_key).decode("ascii"),
    }


def _decode_cert(value: dict[str, Any]) -> WhatsAppAuthCert:
    return WhatsAppAuthCert(
        serial=int(value["serial"]),
        issuer=str(value["issuer"]),
        root_public_key=base64.b64decode(value["rootPublic"]),
        root_private_key=base64.b64decode(value["rootPrivate"]),
        intermediate_public_key=base64.b64decode(value["intermediatePublic"]),
        intermediate_private_key=base64.b64decode(value["intermediatePrivate"]),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    init_parser = subparsers.add_parser("init")
    init_parser.add_argument("scenario", type=Path)
    serve_parser = subparsers.add_parser("serve")
    serve_parser.add_argument("scenario", type=Path)
    serve_parser.add_argument("--port", type=int, default=9000)
    args = parser.parse_args()

    if args.command == "init":
        init_scenario(args.scenario)
        return
    scenario = json.loads(args.scenario.read_text(encoding="utf-8"))
    uvicorn.run(create_app(HarnessState(scenario)), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
