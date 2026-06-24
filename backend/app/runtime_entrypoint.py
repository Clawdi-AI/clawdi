import os
import sys

API_ROLE = "api"
CHANNELS_WORKER_ROLE = "channels-worker"


def _exec(args: list[str]) -> None:
    os.execvp(args[0], args)


def main() -> None:
    role = os.environ.get("CLAWDI_PROCESS_ROLE", API_ROLE).strip() or API_ROLE

    if role == API_ROLE:
        _exec(
            [
                "sh",
                "-c",
                "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000",
            ]
        )
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
