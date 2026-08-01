from __future__ import annotations

import base64
import binascii
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from app.schemas.whatsapp_callback import WhatsAppContractModel
from app.services.whatsapp_sidecar_client import WHATSAPP_OPERATION_MAX_MEDIA_BYTES

_OPERATION_ID_RE = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
_MESSAGE_ID_RE = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$"

WhatsAppApplicationOperationName = Literal[
    "send_text",
    "send_media",
    "reaction",
    "typing",
    "edit_message",
    "delete_message",
    "mark_read",
]


class WhatsAppApplicationModel(WhatsAppContractModel):
    pass


class WhatsAppApplicationCapabilitiesResponse(WhatsAppApplicationModel):
    operations: list[WhatsAppApplicationOperationName]
    typing_states: list[Literal["composing", "recording", "paused"]] = Field(alias="typingStates")
    max_inbox_limit: Literal[100] = Field(default=100, alias="maxInboxLimit")
    max_long_poll_seconds: Literal[30] = Field(default=30, alias="maxLongPollSeconds")
    max_media_bytes: Literal[8_388_608] = Field(
        default=WHATSAPP_OPERATION_MAX_MEDIA_BYTES,
        alias="maxMediaBytes",
    )


class WhatsAppApplicationBinding(WhatsAppApplicationModel):
    id: UUID


class WhatsAppApplicationChat(WhatsAppApplicationModel):
    id: UUID
    type: Literal["direct", "group"]
    name: str | None = Field(default=None, min_length=1, max_length=300)


class WhatsAppApplicationSender(WhatsAppApplicationModel):
    id: str = Field(min_length=1, max_length=64)
    name: str | None = Field(default=None, min_length=1, max_length=200)


class WhatsAppApplicationReaction(WhatsAppApplicationModel):
    emoji: str = Field(max_length=64)
    message_id: str = Field(alias="messageId", min_length=1, max_length=300)


class WhatsAppApplicationMedia(WhatsAppApplicationModel):
    url: str = Field(min_length=1, max_length=2048)
    mime_type: str = Field(alias="mimeType", min_length=1, max_length=255)
    file_name: str | None = Field(default=None, alias="fileName", min_length=1, max_length=255)
    ptt: Literal[True] | None = None


class WhatsAppApplicationMessage(WhatsAppApplicationModel):
    id: str = Field(min_length=1, max_length=300)
    text: str = Field(max_length=16_384)
    timestamp: int = Field(ge=0, le=9_007_199_254_740_991)
    reply_to: str | None = Field(default=None, alias="replyTo", min_length=1, max_length=300)
    reaction: WhatsAppApplicationReaction | None = None
    media: list[WhatsAppApplicationMedia] = Field(default_factory=list, max_length=1)


class WhatsAppInboxEvent(WhatsAppApplicationModel):
    id: UUID
    binding: WhatsAppApplicationBinding
    chat: WhatsAppApplicationChat
    sender: WhatsAppApplicationSender
    message: WhatsAppApplicationMessage


class WhatsAppInboxResponse(WhatsAppApplicationModel):
    events: list[WhatsAppInboxEvent]
    cursor: str


class WhatsAppInboxAckResponse(WhatsAppApplicationModel):
    id: UUID
    acknowledged: Literal[True] = True
    duplicate: bool = False


class WhatsAppOperationTarget(WhatsAppApplicationModel):
    binding_id: UUID = Field(alias="bindingId")
    chat_id: UUID = Field(alias="chatId")
    chat_type: Literal["direct", "group"] = Field(alias="chatType")


class WhatsAppOperationBase(WhatsAppApplicationModel):
    operation_id: str = Field(alias="operationId", pattern=_OPERATION_ID_RE)
    target: WhatsAppOperationTarget


class WhatsAppSendTextOperation(WhatsAppOperationBase):
    type: Literal["send_text"]
    text: str = Field(min_length=1, max_length=4096)
    reply_to: str | None = Field(default=None, alias="replyTo", pattern=_MESSAGE_ID_RE)

    @field_validator("text")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must not be blank")
        return value


class WhatsAppOutboundMedia(WhatsAppApplicationModel):
    relay_url: str | None = Field(default=None, alias="relayUrl", min_length=1, max_length=2048)
    content_base64: str | None = Field(
        default=None,
        alias="contentBase64",
        min_length=1,
        max_length=((WHATSAPP_OPERATION_MAX_MEDIA_BYTES + 2) // 3) * 4,
    )
    kind: Literal["image", "video", "audio", "document"] | None = None
    file_name: str | None = Field(default=None, alias="fileName", min_length=1, max_length=255)

    @model_validator(mode="after")
    def _one_media_source(self) -> WhatsAppOutboundMedia:
        if (self.relay_url is None) == (self.content_base64 is None):
            raise ValueError("media must contain exactly one authorized source")
        if self.content_base64 is not None:
            if self.kind is None:
                raise ValueError("local media kind is required")
            try:
                decoded = base64.b64decode(self.content_base64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError("contentBase64 must be canonical base64") from exc
            if not decoded or len(decoded) > WHATSAPP_OPERATION_MAX_MEDIA_BYTES:
                raise ValueError("media must be between 1 byte and 8 MiB")
            if base64.b64encode(decoded).decode("ascii") != self.content_base64:
                raise ValueError("contentBase64 must be canonical base64")
        return self


class WhatsAppSendMediaOperation(WhatsAppOperationBase):
    type: Literal["send_media"]
    media: WhatsAppOutboundMedia
    text: str | None = Field(default=None, max_length=4096)
    reply_to: str | None = Field(default=None, alias="replyTo", pattern=_MESSAGE_ID_RE)


class WhatsAppReactionOperation(WhatsAppOperationBase):
    type: Literal["reaction"]
    message_id: str = Field(alias="messageId", pattern=_MESSAGE_ID_RE)
    emoji: str = Field(max_length=64)


class WhatsAppTypingOperation(WhatsAppOperationBase):
    type: Literal["typing"]
    active: bool | None = None
    state: Literal["composing", "recording", "paused"] | None = None

    @model_validator(mode="after")
    def _one_typing_state(self) -> WhatsAppTypingOperation:
        if (self.active is None) == (self.state is None):
            raise ValueError("typing requires exactly one of active or state")
        return self


class WhatsAppEditMessageOperation(WhatsAppOperationBase):
    type: Literal["edit_message"]
    message_id: str = Field(alias="messageId", pattern=_MESSAGE_ID_RE)
    text: str = Field(min_length=1, max_length=4096)


class WhatsAppDeleteMessageOperation(WhatsAppOperationBase):
    type: Literal["delete_message"]
    message_id: str = Field(alias="messageId", pattern=_MESSAGE_ID_RE)


class WhatsAppMarkReadOperation(WhatsAppOperationBase):
    type: Literal["mark_read"]
    message_id: str = Field(alias="messageId", pattern=_MESSAGE_ID_RE)


WhatsAppApplicationOperation = Annotated[
    WhatsAppSendTextOperation
    | WhatsAppSendMediaOperation
    | WhatsAppReactionOperation
    | WhatsAppTypingOperation
    | WhatsAppEditMessageOperation
    | WhatsAppDeleteMessageOperation
    | WhatsAppMarkReadOperation,
    Field(discriminator="type"),
]


class WhatsAppOperationResponse(WhatsAppApplicationModel):
    operation_id: str = Field(alias="operationId")
    message_id: str | None = Field(default=None, alias="messageId")
    status: Literal["completed"]
    duplicate: bool = False


class WhatsAppManualCodeRequest(WhatsAppApplicationModel):
    phone_number: str = Field(alias="phoneNumber", pattern=r"^[1-9][0-9]{6,14}$")


class WhatsAppRecoverRequest(WhatsAppApplicationModel):
    accept_version_change: bool = Field(alias="acceptVersionChange")
    reset_logged_out: bool = Field(default=False, alias="resetLoggedOut")


class WhatsAppPairingStatusResponse(WhatsAppApplicationModel):
    status: Literal[
        "starting",
        "pairing_qr",
        "pairing_code",
        "connected",
        "disconnected",
        "fatal",
        "stopped",
    ]
    registered: bool
    method: Literal["qr", "code"] | None = None
    qr: str | None = Field(default=None, min_length=1, max_length=65_536)
    code: str | None = Field(default=None, min_length=1, max_length=200)


class WhatsAppLifecycleResponse(WhatsAppApplicationModel):
    ok: Literal[True] = True
