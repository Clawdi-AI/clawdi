from __future__ import annotations

import hashlib
import json

import pytest
from pydantic import ValidationError

from app.schemas.whatsapp_callback import WhatsAppSidecarEvent


def _event(**changes: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schemaVersion": "clawdi.whatsapp.sidecar-event.v1",
        "accountId": "account-a",
        "eventType": "message",
        "messageId": "message-1",
        "chat": {
            "primary": "15551112222@s.whatsapp.net",
            "alt": "777000111222@lid",
        },
        "actor": {
            "primary": "15551112222@s.whatsapp.net",
            "alt": "777000111222@lid",
        },
        "fromMe": False,
        "ownership": "peer",
        "timestamp": 1_700_000_000,
        "content": {"type": "text", "text": "hello"},
    }
    payload.update(changes)
    payload["providerEventId"] = _provider_event_id(payload)
    return payload


@pytest.mark.parametrize(
    "changes",
    [
        {
            "chat": {"primary": "status@broadcast"},
            "actor": {"primary": "15551112222@s.whatsapp.net"},
        },
        {
            "chat": {"primary": "123@newsletter"},
            "actor": {"primary": "15551112222@s.whatsapp.net"},
        },
        {
            "chat": {"primary": "123@hosted"},
            "actor": {"primary": "15551112222@s.whatsapp.net"},
        },
        {
            "chat": {
                "primary": "15551112222@s.whatsapp.net",
                "alt": "15553334444@s.whatsapp.net",
            }
        },
        {
            "chat": {
                "primary": "120363000000000001@g.us",
                "alt": "777000111222@lid",
            }
        },
        {"actor": {"primary": "120363000000000001@g.us"}},
        {"fromMe": True, "ownership": "peer"},
    ],
)
def test_normalized_event_rejects_global_ambiguous_and_inconsistent_shapes(
    changes: dict[str, object],
):
    with pytest.raises(ValidationError):
        WhatsAppSidecarEvent.model_validate(_event(**changes))


def test_normalized_group_accepts_user_actor_and_exact_sidecar_content_contract():
    payload = _event(
        chat={"primary": "120363000000000001@g.us"},
        actor={
            "primary": "15553334444@s.whatsapp.net",
            "alt": "999000111222@lid",
        },
        content={
            "type": "reaction",
            "reaction": "👍",
            "target": {
                "messageId": "target-1",
                "chatJid": "120363000000000001@g.us",
                "participantJid": "15553334444@s.whatsapp.net",
                "fromMe": False,
            },
        },
    )

    parsed = WhatsAppSidecarEvent.model_validate(payload)

    assert parsed.chat.primary == "120363000000000001@g.us"
    assert parsed.actor.alt == "999000111222@lid"
    assert parsed.content.type == "reaction"


def test_provider_event_id_is_stable_for_primary_alt_swaps_and_checked():
    first = _event()
    swapped = _event(
        chat={"primary": "777000111222@lid", "alt": "15551112222@s.whatsapp.net"},
        actor={"primary": "777000111222@lid", "alt": "15551112222@s.whatsapp.net"},
    )
    assert first["providerEventId"] == swapped["providerEventId"]
    swapped["providerEventId"] = f"message:{'f' * 64}"
    with pytest.raises(ValidationError, match="providerEventId"):
        WhatsAppSidecarEvent.model_validate(swapped)


def test_media_contract_preserves_voice_ptt_and_rejects_it_for_non_audio():
    voice = WhatsAppSidecarEvent.model_validate(
        _event(
            content={
                "type": "media",
                "mediaId": f"media_{'a' * 43}",
                "mediaType": "audio",
                "mimeType": "audio/ogg; codecs=opus",
                "ptt": True,
            }
        )
    )
    assert voice.content.type == "media"
    assert voice.content.ptt is True

    with pytest.raises(ValidationError, match="only for audio"):
        WhatsAppSidecarEvent.model_validate(
            _event(
                content={
                    "type": "media",
                    "mediaId": f"media_{'b' * 43}",
                    "mediaType": "image",
                    "mimeType": "image/jpeg",
                    "ptt": True,
                }
            )
        )


def _provider_event_id(payload: dict[str, object]) -> str:
    chat = payload["chat"]
    actor = payload["actor"]
    assert isinstance(chat, dict)
    assert isinstance(actor, dict)
    identity = {
        "accountId": payload["accountId"],
        "chatAliases": sorted(value for value in chat.values() if isinstance(value, str)),
        "actorAliases": sorted(value for value in actor.values() if isinstance(value, str)),
        "messageId": payload["messageId"],
    }
    encoded = json.dumps(identity, separators=(",", ":"), ensure_ascii=False)
    return f"message:{hashlib.sha256(encoded.encode()).hexdigest()}"
