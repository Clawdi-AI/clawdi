from __future__ import annotations

import os
import signal
import threading
import time

import pytest

from app import runtime_entrypoint


class ExecCalled(Exception):
    def __init__(self, args: list[str]) -> None:
        self.args_list = args


def _capture_exec(args: list[str]) -> None:
    raise ExecCalled(args)


def test_runtime_entrypoint_defaults_to_api_role(monkeypatch):
    monkeypatch.delenv("CLAWDI_PROCESS_ROLE", raising=False)
    monkeypatch.setattr(runtime_entrypoint, "_run_api_with_drain", lambda: 0)

    with pytest.raises(SystemExit) as exc:
        runtime_entrypoint.main()

    assert exc.value.code == 0


def test_runtime_entrypoint_starts_channels_worker_role(monkeypatch):
    monkeypatch.setenv("CLAWDI_PROCESS_ROLE", "channels-worker")
    monkeypatch.setattr(runtime_entrypoint, "_exec", _capture_exec)

    with pytest.raises(ExecCalled) as exc:
        runtime_entrypoint.main()

    assert exc.value.args_list == ["python", "-m", "app.workers.channels"]


def test_runtime_entrypoint_rejects_unknown_role(monkeypatch):
    monkeypatch.setenv("CLAWDI_PROCESS_ROLE", "scheduler")
    monkeypatch.setattr(
        runtime_entrypoint,
        "_exec",
        lambda _args: pytest.fail("unexpected exec"),
    )

    with pytest.raises(SystemExit) as exc:
        runtime_entrypoint.main()

    assert exc.value.code == 64


def test_api_migration_failure_short_circuits(monkeypatch):
    monkeypatch.setattr(runtime_entrypoint, "_API_MIGRATE_ARGS", ["sh", "-c", "exit 3"])
    monkeypatch.setattr(
        runtime_entrypoint,
        "_API_SERVER_ARGS",
        ["sh", "-c", "echo server-should-not-start >&2; exit 99"],
    )

    assert runtime_entrypoint._run_api_with_drain() == 3


def test_api_server_exit_code_propagates(monkeypatch):
    monkeypatch.setattr(runtime_entrypoint, "_API_MIGRATE_ARGS", ["true"])
    monkeypatch.setattr(runtime_entrypoint, "_API_SERVER_ARGS", ["sh", "-c", "exit 7"])

    assert runtime_entrypoint._run_api_with_drain() == 7


def test_api_sigterm_drains_before_forwarding(monkeypatch):
    """The listener must outlive the routing: on SIGTERM the entrypoint keeps
    the server running for the drain window, then forwards the signal. Uses a
    real subprocess and a real signal — no mocks of the mechanism under test.
    """
    monkeypatch.setattr(runtime_entrypoint, "_API_MIGRATE_ARGS", ["true"])
    monkeypatch.setattr(runtime_entrypoint, "_API_SERVER_ARGS", ["sleep", "30"])
    monkeypatch.setattr(runtime_entrypoint, "API_SIGTERM_DRAIN_SECONDS", 0.3)

    timer = threading.Timer(0.2, os.kill, args=(os.getpid(), signal.SIGTERM))
    timer.start()
    started = time.monotonic()
    try:
        code = runtime_entrypoint._run_api_with_drain()
    finally:
        timer.cancel()
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
    elapsed = time.monotonic() - started

    assert code == 128 + signal.SIGTERM
    # SIGTERM at ~0.2s + 0.3s drain: the server must not die before ~0.5s.
    assert elapsed >= 0.5
    assert elapsed < 5
