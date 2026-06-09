from __future__ import annotations

from typing import Literal

IMessageChatType = Literal["direct", "group"]


def build_imessage_route_key(*, chat_guid: str, chat_type: IMessageChatType) -> str:
    return f"imessage:{chat_type}:{chat_guid}"


def parse_imessage_route_key(route_key: str) -> tuple[str, IMessageChatType] | None:
    prefix = "imessage:"
    if not route_key.startswith(prefix):
        return None
    rest = route_key[len(prefix) :]
    chat_type, separator, chat_guid = rest.partition(":")
    if separator != ":" or chat_type not in {"direct", "group"}:
        return None
    chat_guid = chat_guid.strip()
    if not chat_guid:
        return None
    return chat_guid, "group" if chat_type == "group" else "direct"


def derive_imessage_session_key(*, chat_guid: str, chat_type: IMessageChatType) -> str:
    return f"agent:main:imessage:{chat_type}:{chat_guid}"


def detect_imessage_chat_type(chat_guid: str) -> IMessageChatType:
    return "group" if ";+;" in chat_guid else "direct"


def list_imessage_outbound_route_keys(*, to: str) -> list[str]:
    raw = strip_imessage_handle_prefix(to)
    if not raw:
        return []
    is_group_chat_guid = ";+;" in raw
    is_already_chat_guid = is_group_chat_guid or ";-;" in raw
    chat_type: IMessageChatType = "group" if is_group_chat_guid else "direct"

    keys: list[str] = []

    def add(chat_guid: str, key_chat_type: IMessageChatType) -> None:
        key = build_imessage_route_key(chat_guid=chat_guid, chat_type=key_chat_type)
        if key not in keys:
            keys.append(key)

    add(raw, chat_type)
    direct = parse_direct_service_chat_guid(raw)
    if direct is not None and chat_type == "direct":
        for prefix in ("any", "iMessage", "SMS"):
            add(f"{prefix};-;{direct[1]}", "direct")
    elif not is_already_chat_guid and chat_type == "direct":
        for prefix in ("any", "iMessage", "SMS"):
            add(f"{prefix};-;{raw}", "direct")
    return keys


def list_imessage_outbound_chat_guids(*, to: str) -> list[str]:
    guids: list[str] = []
    for key in list_imessage_outbound_route_keys(to=to):
        parsed = parse_imessage_route_key(key)
        if parsed is not None and parsed[0] not in guids:
            guids.append(parsed[0])
    return guids


def resolve_imessage_send_chat_guid(*, requested_chat_guid: str, bound_chat_guid: str) -> str:
    requested = strip_imessage_handle_prefix(requested_chat_guid)
    bound = strip_imessage_handle_prefix(bound_chat_guid)
    if not bound or ";+;" in bound:
        return bound

    bound_direct = parse_direct_service_chat_guid(bound)
    if bound_direct is None:
        return bound if ";-;" in bound else f"iMessage;-;{bound}"
    bound_service, bound_handle = bound_direct
    if bound_service != "any":
        return f"{service_prefix_for_wire(bound_service)};-;{bound_handle}"

    requested_direct = parse_direct_service_chat_guid(requested)
    if requested_direct is not None and requested_direct[0] != "any":
        return f"{service_prefix_for_wire(requested_direct[0])};-;{requested_direct[1]}"
    return f"iMessage;-;{bound_handle}"


def strip_imessage_handle_prefix(target: str) -> str:
    trimmed = target.strip()
    lowered = trimmed.lower()
    for prefix in ("imessage:", "sms:", "auto:"):
        if lowered.startswith(prefix):
            return trimmed[len(prefix) :].strip()
    return trimmed


def parse_direct_service_chat_guid(
    chat_guid: str,
) -> tuple[Literal["any", "imessage", "sms"], str] | None:
    service, separator, handle = chat_guid.partition(";-;")
    handle = handle.strip()
    if separator != ";-;" or not handle:
        return None
    lowered = service.lower()
    if lowered not in {"any", "imessage", "sms"}:
        return None
    return lowered, handle


def service_prefix_for_wire(service: Literal["any", "imessage", "sms"]) -> str:
    if service == "sms":
        return "SMS"
    if service == "imessage":
        return "iMessage"
    return "any"
