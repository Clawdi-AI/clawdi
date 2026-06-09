from __future__ import annotations

from typing import Any

import pytest

from app.services.channels import telegram_chat_from_update


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (
            {"message": {"chat": {"id": 12345, "type": "private"}, "text": "hi"}},
            ("12345", "private", None),
        ),
        (
            {"message": {"chat": {"id": -100123, "type": "supergroup"}, "text": "hi"}},
            ("-100123", "supergroup", None),
        ),
        (
            {
                "callback_query": {
                    "message": {"chat": {"id": 999, "type": "private"}},
                    "data": "btn1",
                }
            },
            ("999", "private", None),
        ),
        (
            {"edited_message": {"chat": {"id": 555, "type": "group"}, "text": "edited"}},
            ("555", "group", None),
        ),
        (
            {"channel_post": {"chat": {"id": -100456, "type": "channel", "title": "News"}}},
            ("-100456", "channel", "News"),
        ),
        (
            {
                "edited_channel_post": {
                    "chat": {"id": -100789, "type": "channel", "username": "updates"}
                }
            },
            ("-100789", "channel", "updates"),
        ),
    ],
)
def test_telegram_routing_extracts_chat_from_message_updates(
    payload: dict[str, Any],
    expected: tuple[str, str, str | None],
):
    assert telegram_chat_from_update(payload) == expected


@pytest.mark.parametrize(
    ("payload", "expected_chat_id"),
    [
        ({"business_connection": {"id": "bc-1", "user_chat_id": 999}}, "999"),
        (
            {"business_message": {"chat": {"id": 11, "type": "private", "first_name": "Alice"}}},
            "11",
        ),
        (
            {
                "edited_business_message": {
                    "chat": {"id": 12, "type": "private", "first_name": "Alice"}
                }
            },
            "12",
        ),
        (
            {
                "deleted_business_messages": {
                    "business_connection_id": "bc-1",
                    "chat": {"id": 13, "type": "private", "first_name": "Alice"},
                    "message_ids": [1, 2, 3],
                }
            },
            "13",
        ),
    ],
)
def test_telegram_routing_extracts_chat_from_business_updates(
    payload: dict[str, Any],
    expected_chat_id: str,
):
    routed = telegram_chat_from_update(payload)

    assert routed is not None
    assert routed[0] == expected_chat_id
    assert routed[1] == "private"


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"my_chat_member": {"chat": {"id": 1, "type": "supergroup"}}}, ("1", "supergroup")),
        ({"chat_member": {"chat": {"id": 2, "type": "supergroup"}}}, ("2", "supergroup")),
        ({"chat_join_request": {"chat": {"id": 3, "type": "channel"}}}, ("3", "channel")),
        ({"chat_boost": {"chat": {"id": 4, "type": "channel"}}}, ("4", "channel")),
        ({"removed_chat_boost": {"chat": {"id": 5, "type": "channel"}}}, ("5", "channel")),
        ({"message_reaction": {"chat": {"id": 6, "type": "group"}}}, ("6", "group")),
        ({"message_reaction_count": {"chat": {"id": 7, "type": "group"}}}, ("7", "group")),
    ],
)
def test_telegram_routing_extracts_chat_from_membership_boost_and_reaction_updates(
    payload: dict[str, Any],
    expected: tuple[str, str],
):
    routed = telegram_chat_from_update(payload)

    assert routed is not None
    assert routed[:2] == expected


def test_telegram_routing_returns_none_for_unsupported_update_type():
    assert telegram_chat_from_update({"poll": {}}) is None
