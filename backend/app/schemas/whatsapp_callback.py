from __future__ import annotations

import hashlib
import json
import re
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

_USER_JID_RE = re.compile(r"^[1-9][0-9]{0,19}@(s\.whatsapp\.net|lid)$")
_GROUP_JID_RE = re.compile(r"^[0-9]{5,30}(?:-[0-9]{1,30})?@g\.us$")
_OPAQUE_ACCOUNT_ID_RE = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
_OPAQUE_MEDIA_ID_RE = r"^media_[A-Za-z0-9_-]{43}$"
_PROVIDER_EVENT_ID_RE = r"^message:[a-f0-9]{64}$"


class WhatsAppContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class WhatsAppJidAliasPair(WhatsAppContractModel):
    primary: str = Field(min_length=3, max_length=100)
    alt: str | None = Field(default=None, min_length=3, max_length=100)


class WhatsAppMessageReference(WhatsAppContractModel):
    message_id: str = Field(alias="messageId", min_length=1, max_length=300)
    chat_jid: str | None = Field(default=None, alias="chatJid", min_length=3, max_length=100)
    chat_jid_alt: str | None = Field(
        default=None,
        alias="chatJidAlt",
        min_length=3,
        max_length=100,
    )
    participant_jid: str | None = Field(
        default=None,
        alias="participantJid",
        min_length=3,
        max_length=100,
    )
    participant_jid_alt: str | None = Field(
        default=None,
        alias="participantJidAlt",
        min_length=3,
        max_length=100,
    )
    from_me: bool = Field(alias="fromMe")

    @model_validator(mode="after")
    def _normalized_reference(self) -> WhatsAppMessageReference:
        if self.chat_jid is None and self.chat_jid_alt is not None:
            raise ValueError("chatJid is required with chatJidAlt")
        if self.chat_jid is not None:
            _validate_chat_pair(self.chat_jid, self.chat_jid_alt)
        if self.participant_jid is None and self.participant_jid_alt is not None:
            raise ValueError("participantJid is required with participantJidAlt")
        if self.participant_jid is not None:
            _validate_user_pair(
                self.participant_jid,
                self.participant_jid_alt,
                "participant",
            )
        return self


class WhatsAppTextContent(WhatsAppContractModel):
    type: Literal["text"]
    text: str = Field(max_length=16_384)


class WhatsAppMediaContent(WhatsAppContractModel):
    type: Literal["media"]
    media_id: str = Field(alias="mediaId", pattern=_OPAQUE_MEDIA_ID_RE)
    media_type: Literal["image", "video", "audio", "document", "sticker"] = Field(alias="mediaType")
    mime_type: str | None = Field(default=None, alias="mimeType", min_length=1, max_length=255)
    ptt: bool | None = None
    file_name: str | None = Field(default=None, alias="fileName", min_length=1, max_length=255)
    file_length: int | None = Field(
        default=None,
        alias="fileLength",
        ge=0,
        le=9_007_199_254_740_991,
    )
    caption: str | None = Field(default=None, max_length=16_384)

    @model_validator(mode="after")
    def _voice_marker_only_for_audio(self) -> WhatsAppMediaContent:
        if self.ptt is not None and self.media_type != "audio":
            raise ValueError("ptt is supported only for audio media")
        return self


class WhatsAppReactionContent(WhatsAppContractModel):
    type: Literal["reaction"]
    reaction: str = Field(max_length=64)
    target: WhatsAppMessageReference


class WhatsAppUnknownContent(WhatsAppContractModel):
    type: Literal["unknown"]
    provider_content_type: str = Field(
        alias="providerContentType",
        min_length=1,
        max_length=80,
    )


WhatsAppInboundContent = Annotated[
    WhatsAppTextContent | WhatsAppMediaContent | WhatsAppReactionContent | WhatsAppUnknownContent,
    Field(discriminator="type"),
]


class WhatsAppSidecarEvent(WhatsAppContractModel):
    schema_version: Literal["clawdi.whatsapp.sidecar-event.v1"] = Field(alias="schemaVersion")
    provider_event_id: str = Field(alias="providerEventId", pattern=_PROVIDER_EVENT_ID_RE)
    account_id: str = Field(alias="accountId", pattern=_OPAQUE_ACCOUNT_ID_RE)
    event_type: Literal["message"] = Field(alias="eventType")
    message_id: str = Field(alias="messageId", min_length=1, max_length=300)
    chat: WhatsAppJidAliasPair
    actor: WhatsAppJidAliasPair
    from_me: bool = Field(alias="fromMe")
    ownership: Literal["self", "peer"]
    content: WhatsAppInboundContent
    reply_to: WhatsAppMessageReference | None = Field(default=None, alias="replyTo")
    push_name: str | None = Field(default=None, alias="pushName", min_length=1, max_length=200)
    timestamp: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991)

    @model_validator(mode="after")
    def _normalized_event(self) -> WhatsAppSidecarEvent:
        _validate_chat_pair(self.chat.primary, self.chat.alt)
        _validate_user_pair(self.actor.primary, self.actor.alt, "actor")
        if self.from_me != (self.ownership == "self"):
            raise ValueError("ownership must agree with fromMe")
        if (
            self.ownership == "peer"
            and _USER_JID_RE.fullmatch(self.chat.primary)
            and not _alias_set(self.actor).issubset(_alias_set(self.chat))
        ):
            raise ValueError("direct peer actor must match the chat identity")
        expected_event_id = _provider_event_id(
            account_id=self.account_id,
            message_id=self.message_id,
            chat=self.chat,
            actor=self.actor,
        )
        if self.provider_event_id != expected_event_id:
            raise ValueError("providerEventId does not match the normalized identity")
        return self


class WhatsAppSidecarEventResponse(WhatsAppContractModel):
    ok: Literal[True] = True
    duplicate: bool = False
    ignored_from_me: bool = Field(default=False, alias="ignoredFromMe")
    ignored_unpaired: bool = Field(default=False, alias="ignoredUnpaired")
    paired: bool = False
    unpaired: bool = False
    binding_id: UUID | None = Field(default=None, alias="bindingId")


def _validate_chat_pair(primary: str, alternate: str | None) -> None:
    if _GROUP_JID_RE.fullmatch(primary):
        if alternate is not None:
            raise ValueError("group chat alternate is not supported")
        return
    _validate_user_pair(primary, alternate, "chat")


def _validate_user_pair(primary: str, alternate: str | None, label: str) -> None:
    if not _USER_JID_RE.fullmatch(primary):
        raise ValueError(f"{label} primary must be a supported user JID")
    if alternate is None:
        return
    if not _USER_JID_RE.fullmatch(alternate):
        raise ValueError(f"{label} alternate must be a supported user JID")
    if primary == alternate or primary.rsplit("@", 1)[1] == alternate.rsplit("@", 1)[1]:
        raise ValueError(f"{label} aliases must be an explicit PN/LID pair")


def _alias_set(pair: WhatsAppJidAliasPair) -> set[str]:
    return {pair.primary, pair.alt} - {None}


def _provider_event_id(
    *,
    account_id: str,
    message_id: str,
    chat: WhatsAppJidAliasPair,
    actor: WhatsAppJidAliasPair,
) -> str:
    identity = {
        "accountId": account_id,
        "chatAliases": sorted(_alias_set(chat)),
        "actorAliases": sorted(_alias_set(actor)),
        "messageId": message_id,
    }
    encoded = json.dumps(identity, separators=(",", ":"), ensure_ascii=False)
    return f"message:{hashlib.sha256(encoded.encode()).hexdigest()}"
