from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
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


def test_runtime_entrypoint_starts_embedding_worker_role(monkeypatch):
    monkeypatch.setenv("CLAWDI_PROCESS_ROLE", "embedding-worker")
    monkeypatch.setattr(runtime_entrypoint, "_exec", _capture_exec)

    with pytest.raises(ExecCalled) as exc:
        runtime_entrypoint.main()

    assert exc.value.args_list == ["python", "-m", "app.workers.embedding"]


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


def test_api_runtime_rejects_unreviewed_worker_capacity() -> None:
    with pytest.raises(RuntimeError, match="worker count must be 1 or 2"):
        runtime_entrypoint._run_uvicorn(workers=3)


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


def test_api_startup_wipes_prometheus_multiprocess_dir(monkeypatch, tmp_path):
    metrics_dir = tmp_path / runtime_entrypoint.PROMETHEUS_MULTIPROC_DIR_NAME
    metrics_dir.mkdir()
    (metrics_dir / "counter_123.db").write_bytes(b"stale")
    monkeypatch.setenv("PROMETHEUS_MULTIPROC_DIR", str(metrics_dir))
    monkeypatch.setattr(runtime_entrypoint, "_API_MIGRATE_ARGS", ["true"])
    monkeypatch.setattr(runtime_entrypoint, "_API_SERVER_ARGS", ["true"])

    assert runtime_entrypoint._run_api_with_drain() == 0
    assert list(metrics_dir.iterdir()) == []


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


@pytest.mark.parametrize("worker_signal", [signal.SIGTERM, signal.SIGKILL])
def test_uvicorn_supervisor_reaps_live_gauges_on_worker_exit(
    tmp_path: Path,
    worker_signal: signal.Signals,
) -> None:
    metrics_dir = tmp_path / runtime_entrypoint.PROMETHEUS_MULTIPROC_DIR_NAME
    metrics_dir.mkdir()
    backend_root = Path(__file__).parents[1]
    with socket.socket() as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]

    env = os.environ.copy()
    env["PROMETHEUS_MULTIPROC_DIR"] = str(metrics_dir)
    command = [
        sys.executable,
        "-c",
        (
            "from app.runtime_entrypoint import _run_uvicorn; "
            "raise SystemExit(_run_uvicorn("
            "app='tests.fixtures.prometheus_multiprocess_app:app', "
            f"host='127.0.0.1', port={port}, workers=2))"
        ),
    ]
    server = subprocess.Popen(
        command,
        cwd=backend_root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    def worker_pids() -> set[int]:
        return {
            int(path.stem.removeprefix("gauge_livesum_"))
            for path in metrics_dir.glob("gauge_livesum_*.db")
        }

    def metrics_text() -> str | None:
        try:
            return httpx.get(f"http://127.0.0.1:{port}/metrics", timeout=0.5).text
        except httpx.HTTPError:
            return None

    try:
        deadline = time.monotonic() + 15
        initial_workers: set[int] = set()
        while time.monotonic() < deadline:
            initial_workers = worker_pids()
            text = metrics_text()
            if len(initial_workers) == 2 and text and "test_workers_live 2.0" in text:
                break
            if server.poll() is not None:
                break
            time.sleep(0.05)
        else:
            pytest.fail("Uvicorn workers did not become ready")

        assert server.poll() is None
        assert len(initial_workers) == 2
        dead_pid = min(initial_workers)
        assert (metrics_dir / f"gauge_livesum_{dead_pid}.db").exists()

        os.kill(dead_pid, worker_signal)
        deadline = time.monotonic() + 15
        replacement_workers: set[int] = set()
        while time.monotonic() < deadline:
            replacement_workers = worker_pids()
            text = metrics_text()
            if (
                len(replacement_workers) == 2
                and dead_pid not in replacement_workers
                and text is not None
                and "test_workers_live 2.0" in text
                and "test_worker_starts_total 3.0" in text
                and "test_worker_start_duration_seconds_count 3.0" in text
            ):
                break
            if server.poll() is not None:
                break
            time.sleep(0.05)
        else:
            pytest.fail("Uvicorn did not replace the exited worker with clean live gauges")

        assert server.poll() is None
        assert not (metrics_dir / f"gauge_livesum_{dead_pid}.db").exists()
        assert (metrics_dir / f"counter_{dead_pid}.db").exists()
        assert (metrics_dir / f"histogram_{dead_pid}.db").exists()

        server.send_signal(signal.SIGTERM)
        assert server.wait(timeout=15) == 0
        assert list(metrics_dir.glob("gauge_live*.db")) == []
    finally:
        if server.poll() is None:
            server.kill()
            server.wait(timeout=5)
