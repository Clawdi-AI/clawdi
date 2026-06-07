from __future__ import annotations

from app.services.channels import extract_discord_routing_key


def test_discord_routing_extracts_guild_message_by_guild_with_channel_id():
    key = extract_discord_routing_key(
        {
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "msg-1",
                "guild_id": "1469655705752441026",
                "channel_id": "1494815997981491361",
                "channel_type": 0,
            },
        }
    )

    assert key is not None
    assert key.chat_id == "1469655705752441026"
    assert key.scope_id == "1469655705752441026"
    assert key.channel_id == "1494815997981491361"
    assert key.chat_type == "guild_text"


def test_discord_routing_extracts_reaction_add():
    key = extract_discord_routing_key(
        {
            "t": "MESSAGE_REACTION_ADD",
            "d": {
                "guild_id": "1469655705752441026",
                "channel_id": "1494815997981491361",
                "message_id": "1494831575131492536",
            },
        }
    )

    assert key is not None
    assert key.chat_id == "1469655705752441026"
    assert key.scope_id == "1469655705752441026"
    assert key.channel_id == "1494815997981491361"


def test_discord_routing_extracts_interaction_create():
    key = extract_discord_routing_key(
        {
            "t": "INTERACTION_CREATE",
            "d": {
                "id": "interaction-1",
                "guild_id": "1469655705752441026",
                "channel_id": "1494815997981491361",
            },
        }
    )

    assert key is not None
    assert key.chat_id == "1469655705752441026"
    assert key.channel_id == "1494815997981491361"


def test_discord_routing_extracts_thread_create_to_guild():
    key = extract_discord_routing_key(
        {
            "t": "THREAD_CREATE",
            "d": {
                "id": "thread-1",
                "guild_id": "1469655705752441026",
                "type": 11,
            },
        }
    )

    assert key is not None
    assert key.chat_id == "1469655705752441026"
    assert key.scope_id == "1469655705752441026"
    assert key.channel_id == "thread-1"
    assert key.chat_type == "public_thread"


def test_discord_routing_returns_none_for_ready_and_no_payload():
    assert extract_discord_routing_key({"t": "READY", "d": {"session_id": "s-1"}}) is None
    assert extract_discord_routing_key({"t": "HEARTBEAT_ACK"}) is None


def test_discord_routing_routes_guild_scoped_events_without_channel():
    key = extract_discord_routing_key(
        {
            "t": "GUILD_MEMBER_ADD",
            "d": {"guild_id": "1469655705752441026", "user": {"id": "u-1"}},
        }
    )

    assert key is not None
    assert key.chat_id == "1469655705752441026"
    assert key.scope_id == "1469655705752441026"
    assert key.channel_id is None
    assert key.chat_type == "guild_text"
    assert (
        extract_discord_routing_key(
            {
                "t": "GUILD_BAN_ADD",
                "d": {"guild_id": "1469655705752441026", "user": {"id": "u-1"}},
            }
        ).chat_id
        == "1469655705752441026"
    )
    assert (
        extract_discord_routing_key(
            {
                "t": "GUILD_ROLE_CREATE",
                "d": {"guild_id": "1469655705752441026", "role": {"id": "r-1"}},
            }
        ).chat_id
        == "1469655705752441026"
    )


def test_discord_routing_returns_none_without_channel_or_guild_context():
    assert extract_discord_routing_key({"t": "USER_UPDATE", "d": {"id": "u-1"}}) is None
