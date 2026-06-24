from __future__ import annotations

import pytest

from app import runtime_entrypoint


class ExecCalled(Exception):
    def __init__(self, args: list[str]) -> None:
        self.args_list = args


def _capture_exec(args: list[str]) -> None:
    raise ExecCalled(args)


def test_runtime_entrypoint_defaults_to_api_role(monkeypatch):
    monkeypatch.delenv("CLAWDI_PROCESS_ROLE", raising=False)
    monkeypatch.setattr(runtime_entrypoint, "_exec", _capture_exec)

    with pytest.raises(ExecCalled) as exc:
        runtime_entrypoint.main()

    assert exc.value.args_list == [
        "sh",
        "-c",
        "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000",
    ]


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
