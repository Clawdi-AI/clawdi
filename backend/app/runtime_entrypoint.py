import os
import signal
import subprocess
import sys
import time
from pathlib import Path

API_ROLE = "api"
CHANNELS_WORKER_ROLE = "channels-worker"
PROMETHEUS_MULTIPROC_DIR_NAME = "clawdi-prometheus-multiproc"

# How long the API keeps serving after SIGTERM. Some container proxies only
# stop routing on the container's die event, so the listener must stay open
# past the stop signal or a rolling deploy can feed a few seconds of traffic
# to a closed socket (surfacing in browsers as CORS-less 502s).
# Together with uvicorn's graceful shutdown this must stay under the 10s
# docker stop timeout, after which the container is SIGKILLed.
API_SIGTERM_DRAIN_SECONDS = 5

_API_MIGRATE_ARGS = ["alembic", "upgrade", "head"]
_API_SERVER_ARGS = [
    "uvicorn",
    "app.main:app",
    "--host",
    "0.0.0.0",
    "--port",
    "8000",
    "--no-access-log",
]


def _prepare_prometheus_multiprocess_dir() -> None:
    raw_path = os.environ.get("PROMETHEUS_MULTIPROC_DIR", "").strip()
    if not raw_path:
        return
    directory = Path(raw_path).resolve()
    if directory.name != PROMETHEUS_MULTIPROC_DIR_NAME:
        raise RuntimeError(
            f"PROMETHEUS_MULTIPROC_DIR must end with {PROMETHEUS_MULTIPROC_DIR_NAME!r}"
        )
    directory.mkdir(parents=True, exist_ok=True)
    for entry in directory.iterdir():
        if not entry.is_file():
            raise RuntimeError(f"Prometheus multiprocess directory contains {entry.name!r}")
        entry.unlink()


def _exec(args: list[str]) -> None:
    os.execvp(args[0], args)


def _run_api_with_drain() -> int:
    _prepare_prometheus_multiprocess_dir()
    migrate = subprocess.run(_API_MIGRATE_ARGS)
    if migrate.returncode != 0:
        return migrate.returncode

    _prepare_prometheus_multiprocess_dir()
    server = subprocess.Popen(_API_SERVER_ARGS)

    def _drain_then_forward(_signum: int, _frame: object) -> None:
        time.sleep(API_SIGTERM_DRAIN_SECONDS)
        server.send_signal(signal.SIGTERM)

    signal.signal(signal.SIGTERM, _drain_then_forward)
    code = server.wait()
    # Popen reports death-by-signal as a negative returncode; translate to
    # the conventional 128+N shell encoding so docker records it faithfully.
    return 128 - code if code < 0 else code


def main() -> None:
    role = os.environ.get("CLAWDI_PROCESS_ROLE", API_ROLE).strip() or API_ROLE

    if role == API_ROLE:
        raise SystemExit(_run_api_with_drain())
    if role == CHANNELS_WORKER_ROLE:
        _exec(["python", "-m", "app.workers.channels"])

    print(
        f"Unsupported CLAWDI_PROCESS_ROLE={role!r}; expected "
        f"{API_ROLE!r} or {CHANNELS_WORKER_ROLE!r}.",
        file=sys.stderr,
    )
    raise SystemExit(64)


if __name__ == "__main__":
    main()
