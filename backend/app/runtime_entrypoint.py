import os
import signal
import subprocess
import sys
import time

API_ROLE = "api"
CHANNELS_WORKER_ROLE = "channels-worker"

# How long the API keeps serving after SIGTERM. The Coolify proxy (traefik)
# only stops routing to a container on its die event, so the listener must
# stay open past the stop signal or every rolling deploy feeds a few seconds
# of traffic to a closed socket (surfacing in browsers as CORS-less 502s).
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


def _exec(args: list[str]) -> None:
    os.execvp(args[0], args)


def _run_api_with_drain() -> int:
    migrate = subprocess.run(_API_MIGRATE_ARGS)
    if migrate.returncode != 0:
        return migrate.returncode

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
