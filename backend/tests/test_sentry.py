import os
import subprocess
import sys
from pathlib import Path

import httpx
from sentry_sdk.types import Event, Hint
from starlette.exceptions import HTTPException

from app.core.sentry import _before_send


def test_scrub_event_redacts_nested_credentials_without_changing_shape() -> None:
    payload: dict[object, object] = {
        "authorization": "exact-secret",
        "service_api_key": "suffix-secret",
        "items": [
            {"CLIENT_SECRET": "case-insensitive-secret", "label": "visible"},
            {7: {"access_token": "nested-secret", "display_name": "visible"}},
        ],
        "public_key_id": "visible",
    }
    event: Event = {"extra": {"payload": payload}}
    hint: Hint = {}

    result = _before_send(event, hint)

    assert result is event
    assert payload == {
        "authorization": "[redacted]",
        "service_api_key": "[redacted]",
        "items": [
            {"CLIENT_SECRET": "[redacted]", "label": "visible"},
            {7: {"access_token": "[redacted]", "display_name": "visible"}},
        ],
        "public_key_id": "visible",
    }


def _raised_hint(exc: HTTPException, cause: BaseException | None) -> Hint:
    try:
        raise exc from cause
    except HTTPException as raised:
        return {"exc_info": (type(raised), raised, raised.__traceback__)}


def test_before_send_drops_only_provider_transport_failures() -> None:
    unreachable = _raised_hint(
        HTTPException(502, "telegram api unreachable"), httpx.ConnectError("refused")
    )
    rejected = _raised_hint(HTTPException(502, "telegram bot token was rejected"), None)
    internal = _raised_hint(HTTPException(500, "failed"), httpx.ConnectError("refused"))

    assert _before_send({}, unreachable) is None
    assert _before_send({}, rejected) == {}
    assert _before_send({}, internal) == {}


def test_disabled_sentry_does_not_import_sdk() -> None:
    completed = subprocess.run(
        [
            sys.executable,
            "-X",
            "importtime",
            "-c",
            "from app.core.sentry import init_sentry; init_sentry()",
        ],
        check=False,
        capture_output=True,
        cwd=Path(__file__).resolve().parents[1],
        env=os.environ | {"SENTRY_DSN": ""},
        text=True,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stderr
    assert "sentry_sdk" not in completed.stderr
