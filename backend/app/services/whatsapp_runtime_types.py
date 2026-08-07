from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from app.services.whatsapp_baileys import BinaryNode


@dataclass(frozen=True)
class WhatsAppOutboundMessage:
    to_jid: str
    message_id: str
    message_proto: bytes
    enc_type: Literal["pkmsg", "msg", "skmsg"]
    attrs: dict[str, str]
    conversation: str | None = None
    additional_nodes: tuple[BinaryNode, ...] = ()
