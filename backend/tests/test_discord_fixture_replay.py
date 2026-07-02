from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, TypedDict


class DiscordFixture(TypedDict):
    slug: str
    manifest: dict[str, Any]
    frames: list[dict[str, Any]]


class DiscordRestPair(TypedDict):
    request: dict[str, Any]
    response: dict[str, Any]


FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "discord"


def load_discord_fixture(slug: str) -> DiscordFixture:
    manifest = json.loads((FIXTURE_ROOT / slug / "manifest.json").read_text())
    frames = [
        json.loads(line)
        for line in (FIXTURE_ROOT / slug / "capture.jsonl").read_text().splitlines()
        if line.strip()
    ]
    return {"slug": slug, "manifest": manifest, "frames": frames}


def discord_ws_frames(
    fixture: DiscordFixture,
    direction: str | None = None,
) -> list[dict[str, Any]]:
    return [
        frame
        for frame in fixture["frames"]
        if frame.get("kind") == "ws" and (direction is None or frame.get("direction") == direction)
    ]


def discord_rest_pairs(fixture: DiscordFixture) -> list[DiscordRestPair]:
    rest = [frame for frame in fixture["frames"] if frame.get("kind") == "rest"]
    pairs: list[DiscordRestPair] = []
    index = 0
    while index < len(rest):
        request = rest[index]
        response = rest[index + 1] if index + 1 < len(rest) else None
        if request.get("direction") == "c2s" and response and response.get("direction") == "s2c":
            pairs.append({"request": request, "response": response})
            index += 2
            continue
        index += 1
    return pairs


def is_multipart_fixture_body(body: Any) -> bool:
    return (
        isinstance(body, dict)
        and isinstance(body.get("_boundary"), str)
        and isinstance(
            body.get("files"),
            list,
        )
        and "payload_json" in body
    )


def build_multipart_fixture_body(body: dict[str, Any]) -> tuple[bytes, str]:
    boundary = body["_boundary"]
    parts: list[bytes] = []

    def push(value: str | bytes) -> None:
        parts.append(value.encode("utf-8") if isinstance(value, str) else value)

    push(f"--{boundary}\r\n")
    push('Content-Disposition: form-data; name="payload_json"\r\n')
    push("Content-Type: application/json\r\n\r\n")
    push(json.dumps(body["payload_json"], separators=(",", ":")))
    push("\r\n")
    for file in body["files"]:
        push(f"--{boundary}\r\n")
        push(
            "Content-Disposition: form-data; "
            f'name="{file["field"]}"; filename="{file["filename"]}"\r\n'
        )
        push(f"Content-Type: {file['content_type']}\r\n\r\n")
        push(base64.b64decode(file["data_base64"]))
        push("\r\n")
    push(f"--{boundary}--\r\n")
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def test_discord_fixture_loads_startup_hello_frame():
    fixture = load_discord_fixture("01-startup")
    assert fixture["manifest"]["scenario"] == "01-startup"
    server_frames = discord_ws_frames(fixture, "s2c")
    assert len(server_frames) >= 3
    hello = next(frame for frame in server_frames if frame.get("op") == 10)
    assert hello["d"]["heartbeat_interval"] > 0


def test_discord_fixture_loads_send_channel_message_rest_pair():
    fixture = load_discord_fixture("04-send-channel-message")
    pairs = discord_rest_pairs(fixture)
    assert len(pairs) == 1
    assert pairs[0]["request"]["method"] == "POST"
    assert "/messages" in pairs[0]["request"]["path"]
    assert pairs[0]["response"]["status"] == 200


def test_discord_fixture_loads_user_single_image_attachment():
    fixture = load_discord_fixture("22-user-send-single-image")
    message = next(
        frame for frame in discord_ws_frames(fixture, "s2c") if frame.get("t") == "MESSAGE_CREATE"
    )
    assert len(message["d"]["attachments"]) == 1


def test_discord_fixture_exposes_manifest_env():
    fixture = load_discord_fixture("03-receive-channel-message")
    assert fixture["manifest"]["env"]["channel_id"] == "1494815997981491361"
    assert fixture["manifest"]["env"]["guild_id"] == "1469655705752441026"


def test_discord_fixture_reconstructs_multipart_body():
    fixture = load_discord_fixture("21-bot-send-single-image")
    pair = discord_rest_pairs(fixture)[0]
    body = pair["request"]["body"]
    assert is_multipart_fixture_body(body)
    buffer, content_type = build_multipart_fixture_body(body)

    assert content_type.startswith("multipart/form-data; boundary=")
    text = buffer.decode("utf-8", errors="ignore")
    assert 'name="payload_json"' in text
    assert json.dumps(body["payload_json"], separators=(",", ":")) in text
    assert f'filename="{body["files"][0]["filename"]}"' in text
    assert f"--{body['_boundary']}--\r\n" in text
