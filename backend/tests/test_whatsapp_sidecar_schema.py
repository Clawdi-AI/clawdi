from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.channel import WhatsAppSidecarEvent

_EVENT_ID = f"message:{'a' * 64}"


def _event() -> dict[str, object]:
    return {
        "schemaVersion": "clawdi.whatsapp.sidecar-event.v1",
        "providerEventId": _EVENT_ID,
        "messageId": "message-1",
        "chatJid": "15551112222@s.whatsapp.net",
        "chatJidAlt": "7826185388106@lid",
        "actorJid": "15551112222@s.whatsapp.net",
        "actorJidAlt": "7826185388106@lid",
        "fromMe": False,
        "text": "hello",
    }


@pytest.mark.parametrize(
    ("changes", "detail"),
    [
        ({"providerEventId": "message:other"}, "String should match pattern"),
        (
            {
                "chatJid": "120363000000000001@g.us",
                "chatJidAlt": None,
                "actorJid": "120363000000000002@g.us",
                "actorJidAlt": None,
            },
            "invalid WhatsApp sidecar user JID",
        ),
        ({"actorJid": "15551113333@s.whatsapp.net"}, "DM actorJid must match"),
        ({"actorJidAlt": "15551114444@s.whatsapp.net"}, "DM actorJidAlt must match"),
        (
            {"chatJid": "status@broadcast", "actorJid": "status@broadcast"},
            "invalid WhatsApp sidecar chat JID",
        ),
        (
            {"chatJid": "12345@newsletter", "actorJid": "12345@newsletter"},
            "invalid WhatsApp sidecar chat JID",
        ),
        (
            {"chatJid": "15551112222@other.example", "actorJid": "15551112222@other.example"},
            "invalid WhatsApp sidecar chat JID",
        ),
    ],
)
def test_normalized_event_rejects_cross_field_identity_mismatches(
    changes: dict[str, object], detail: str
):
    payload = _event()
    payload.update(changes)

    with pytest.raises(ValidationError, match=detail):
        WhatsAppSidecarEvent.model_validate(payload)


def test_normalized_event_accepts_group_chat_with_participant_actor():
    payload = _event()
    payload.update(
        {
            "chatJid": "120363000000000001@g.us",
            "chatJidAlt": None,
            "actorJid": "15551112222@s.whatsapp.net",
            "actorJidAlt": "7826185388106@lid",
        }
    )

    parsed = WhatsAppSidecarEvent.model_validate(payload)

    assert parsed.chat_jid.endswith("@g.us")
    assert parsed.actor_jid == "15551112222@s.whatsapp.net"


def test_normalized_event_preserves_content_whitespace_and_rejects_invalid_length():
    payload = _event()
    payload["text"] = "  hello\nworld\t "

    parsed = WhatsAppSidecarEvent.model_validate(payload)

    assert parsed.text == "  hello\nworld\t "
    payload["text"] = " \n\t "
    with pytest.raises(ValidationError, match="must not be blank"):
        WhatsAppSidecarEvent.model_validate(payload)
    payload["text"] = "x" * 4097
    with pytest.raises(ValidationError, match="at most 4096"):
        WhatsAppSidecarEvent.model_validate(payload)
