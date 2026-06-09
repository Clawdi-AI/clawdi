from __future__ import annotations

from app.services.imessage_routing import (
    build_imessage_route_key,
    derive_imessage_session_key,
    detect_imessage_chat_type,
    list_imessage_outbound_route_keys,
    parse_imessage_route_key,
    resolve_imessage_send_chat_guid,
)


def test_imessage_routing_builds_and_parses_route_keys():
    assert (
        build_imessage_route_key(chat_guid="iMessage;-;+15551234567", chat_type="direct")
        == "imessage:direct:iMessage;-;+15551234567"
    )
    assert (
        build_imessage_route_key(chat_guid="5463cfdf096c463f8f89d69120143b98", chat_type="group")
        == "imessage:group:5463cfdf096c463f8f89d69120143b98"
    )
    assert parse_imessage_route_key("imessage:direct:any;-;+12817980600") == (
        "any;-;+12817980600",
        "direct",
    )
    assert parse_imessage_route_key("imessage:group:5463cfdf096c463f8f89d69120143b98") == (
        "5463cfdf096c463f8f89d69120143b98",
        "group",
    )
    assert parse_imessage_route_key("imessage:direct:any;-;dhzhtun@qq.com") == (
        "any;-;dhzhtun@qq.com",
        "direct",
    )


def test_imessage_routing_rejects_malformed_route_keys():
    assert parse_imessage_route_key("imessage:other:xxx") is None
    assert parse_imessage_route_key("imessage:direct:") is None
    assert parse_imessage_route_key("telegram:default:chat:123") is None
    assert parse_imessage_route_key("imessage") is None


def test_imessage_routing_detects_chat_type_and_session_key():
    assert (
        derive_imessage_session_key(chat_guid="x", chat_type="direct")
        == "agent:main:imessage:direct:x"
    )
    assert (
        derive_imessage_session_key(chat_guid="x", chat_type="group")
        == "agent:main:imessage:group:x"
    )
    assert detect_imessage_chat_type("iMessage;+;chat123") == "group"
    assert detect_imessage_chat_type("iMessage;-;+15551234567") == "direct"
    assert detect_imessage_chat_type("anything-else") == "direct"


def test_imessage_routing_synthesizes_direct_service_variants():
    assert list_imessage_outbound_route_keys(to="+15551234567") == [
        "imessage:direct:+15551234567",
        "imessage:direct:any;-;+15551234567",
        "imessage:direct:iMessage;-;+15551234567",
        "imessage:direct:SMS;-;+15551234567",
    ]
    keys = list_imessage_outbound_route_keys(to="imessage:+15551234567")
    assert keys[0] == "imessage:direct:+15551234567"
    assert "imessage:direct:iMessage;-;+15551234567" in keys
    assert list_imessage_outbound_route_keys(to="iMessage;-;+15551234567") == [
        "imessage:direct:iMessage;-;+15551234567",
        "imessage:direct:any;-;+15551234567",
        "imessage:direct:SMS;-;+15551234567",
    ]


def test_imessage_routing_keeps_group_chat_guids_exact():
    assert list_imessage_outbound_route_keys(to="iMessage;+;5463cfdf096c463f8f89d69120143b98") == [
        "imessage:group:iMessage;+;5463cfdf096c463f8f89d69120143b98",
    ]
    assert list_imessage_outbound_route_keys(to="") == []
    assert list_imessage_outbound_route_keys(to="imessage:") == []


def test_imessage_routing_resolves_provider_send_chat_guid():
    assert (
        resolve_imessage_send_chat_guid(
            requested_chat_guid="iMessage;-;+15551234567",
            bound_chat_guid="iMessage;-;+15551234567",
        )
        == "iMessage;-;+15551234567"
    )
    assert (
        resolve_imessage_send_chat_guid(
            requested_chat_guid="any;-;+15551234567",
            bound_chat_guid="any;-;+15551234567",
        )
        == "iMessage;-;+15551234567"
    )
    assert (
        resolve_imessage_send_chat_guid(
            requested_chat_guid="SMS;-;+15551234567",
            bound_chat_guid="any;-;+15551234567",
        )
        == "SMS;-;+15551234567"
    )
    assert (
        resolve_imessage_send_chat_guid(
            requested_chat_guid="iMessage;+;groupABC",
            bound_chat_guid="iMessage;+;groupABC",
        )
        == "iMessage;+;groupABC"
    )
