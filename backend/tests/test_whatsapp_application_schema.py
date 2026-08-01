from __future__ import annotations

import base64
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from app.schemas.whatsapp_application import (
    WhatsAppApplicationOperation,
    WhatsAppRecoverRequest,
)
from app.services.whatsapp_sidecar_client import WHATSAPP_OPERATION_MAX_MEDIA_BYTES


def _target() -> dict[str, str]:
    binding_id = str(uuid4())
    return {
        "bindingId": binding_id,
        "chatId": binding_id,
        "chatType": "direct",
    }


def test_typed_operation_rejects_provider_facades_and_arbitrary_jids():
    adapter = TypeAdapter(WhatsAppApplicationOperation)
    with pytest.raises(ValidationError):
        adapter.validate_python(
            {
                "schemaVersion": "clawdi.whatsapp.sidecar-operation.v1",
                "operationId": "send-1",
                "type": "sendText",
                "target": _target(),
                "text": "hello",
                "jid": "15551112222@s.whatsapp.net",
                "rawNode": {"tag": "message"},
            }
        )


@pytest.mark.parametrize("state", ["available", "unavailable"])
def test_typing_rejects_global_presence(state: str):
    adapter = TypeAdapter(WhatsAppApplicationOperation)
    with pytest.raises(ValidationError):
        adapter.validate_python(
            {
                "operationId": "typing-1",
                "type": "typing",
                "target": _target(),
                "state": state,
            }
        )


@pytest.mark.parametrize("state", ["composing", "recording", "paused"])
def test_typing_accepts_only_chat_scoped_presence(state: str):
    operation = TypeAdapter(WhatsAppApplicationOperation).validate_python(
        {
            "operationId": "typing-1",
            "type": "typing",
            "target": _target(),
            "state": state,
        }
    )
    assert operation.type == "typing"
    assert operation.state == state


def test_mark_read_is_narrow_and_requires_message_and_binding_target():
    adapter = TypeAdapter(WhatsAppApplicationOperation)
    operation = adapter.validate_python(
        {
            "operationId": "read-1",
            "type": "mark_read",
            "target": _target(),
            "messageId": "provider-message-1",
        }
    )
    assert operation.type == "mark_read"
    assert operation.message_id == "provider-message-1"
    with pytest.raises(ValidationError):
        adapter.validate_python(
            {
                "operationId": "read-2",
                "type": "mark_read",
                "target": _target(),
                "jid": "15551112222@s.whatsapp.net",
            }
        )


def test_outbound_media_accepts_exactly_eight_mib_and_denies_voice():
    adapter = TypeAdapter(WhatsAppApplicationOperation)
    encoded = base64.b64encode(b"a" * WHATSAPP_OPERATION_MAX_MEDIA_BYTES).decode()
    operation = adapter.validate_python(
        {
            "operationId": "media-1",
            "type": "send_media",
            "target": _target(),
            "media": {"contentBase64": encoded, "kind": "audio"},
        }
    )
    assert operation.type == "send_media"

    with pytest.raises(ValidationError):
        adapter.validate_python(
            {
                "operationId": "media-too-large",
                "type": "send_media",
                "target": _target(),
                "media": {
                    "contentBase64": base64.b64encode(
                        b"a" * (WHATSAPP_OPERATION_MAX_MEDIA_BYTES + 1)
                    ).decode(),
                    "kind": "document",
                },
            }
        )
    with pytest.raises(ValidationError):
        adapter.validate_python(
            {
                "operationId": "media-voice",
                "type": "send_media",
                "target": _target(),
                "media": {"contentBase64": "YQ==", "kind": "voice"},
            }
        )


def test_recovery_reset_logged_out_is_explicit_and_defaults_false():
    ordinary = WhatsAppRecoverRequest.model_validate({"acceptVersionChange": True})
    explicit = WhatsAppRecoverRequest.model_validate(
        {"acceptVersionChange": False, "resetLoggedOut": True}
    )
    assert ordinary.reset_logged_out is False
    assert explicit.reset_logged_out is True
    with pytest.raises(ValidationError):
        WhatsAppRecoverRequest.model_validate({"acceptVersionChange": False, "reset": True})
