import logging
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from socket import socket
from typing import cast

from prometheus_client import multiprocess as prometheus_multiprocess
from uvicorn.config import STARTUP_FAILURE, Config
from uvicorn.server import Server
from uvicorn.supervisors import Multiprocess
from uvicorn.supervisors.multiprocess import Process

logger = logging.getLogger("uvicorn.error")
_mark_process_dead = cast(
    Callable[[int, str], None],
    prometheus_multiprocess.mark_process_dead,
)

API_ROLE = "api"
CHANNELS_WORKER_ROLE = "channels-worker"
EMBEDDING_WORKER_ROLE = "embedding-worker"
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
    "python",
    "-m",
    "app.runtime_entrypoint",
    "_serve-api",
]


class _PrometheusProcess(Process):
    def __init__(self, config: Config, sockets: list[socket], metrics_dir: Path) -> None:
        super().__init__(config, sockets)
        self._metrics_dir = metrics_dir

    def join(self) -> None:
        pid = self.pid
        super().join()
        if pid is not None:
            _mark_process_dead(pid, str(self._metrics_dir))


class _PrometheusMultiprocess(Multiprocess):
    """Uvicorn's pinned supervisor with worker-exit metric cleanup."""

    def __init__(self, config: Config, sockets: list[socket], metrics_dir: Path) -> None:
        super().__init__(config, sockets)
        self.processes_num: int = config.workers
        self._metrics_dir = metrics_dir

    def _new_process(self) -> _PrometheusProcess:
        return _PrometheusProcess(self.config, self.sockets, self._metrics_dir)

    def init_processes(self) -> None:
        for _ in range(self.processes_num):
            process = self._new_process()
            process.start()
            self.processes.append(process)

    def restart_all(self) -> None:
        """Replace each worker only after its successor becomes ready."""
        for index, old_process in enumerate(self.processes):
            if self.should_exit.is_set():
                return

            new_process = self._new_process()
            new_process.start()
            if not new_process.wait_until_ready(
                self.config.timeout_worker_healthcheck, self.should_exit
            ):
                new_process.kill()
                new_process.join()
                if not self.should_exit.is_set():
                    logger.error(
                        "New child process [%s] was not ready in time; keeping worker [%s] "
                        "and aborting the restart.",
                        new_process.pid,
                        old_process.pid,
                    )
                return

            old_process.terminate()
            old_process.join()
            self.processes[index] = new_process

    def keep_subprocess_alive(self) -> None:
        if self.should_exit.is_set():
            return  # Parent is exiting; run() will terminate and join every worker.

        for index, process in enumerate(self.processes):
            if process.is_alive(timeout=self.config.timeout_worker_healthcheck):
                continue

            process.kill()
            process.join()
            if process.exitcode == STARTUP_FAILURE:
                logger.error(
                    "Child process [%s] failed to start, stopping the parent process.",
                    process.pid,
                )
                self.should_exit.set()
                return
            if self.should_exit.is_set():
                return

            logger.info("Child process [%s] died", process.pid)
            replacement = self._new_process()
            replacement.start()
            self.processes[index] = replacement

    def handle_ttin(self) -> None:
        if self.processes_num >= self.config.workers:
            logger.warning(
                "Ignoring TTIN: API worker capacity is capped at %s",
                self.config.workers,
            )
            return
        self.processes_num += 1
        process = self._new_process()
        process.start()
        self.processes.append(process)


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


def _run_uvicorn(
    app: str = "app.main:app",
    host: str = "0.0.0.0",
    port: int = 8000,
    workers: int | None = None,
) -> int:
    config = Config(app, host=host, port=port, workers=workers, access_log=False)
    if config.workers not in (1, 2):
        raise RuntimeError("API worker count must be 1 or 2")
    server = Server(config)

    try:
        if config.workers > 1:
            raw_path = os.environ.get("PROMETHEUS_MULTIPROC_DIR", "").strip()
            if not raw_path:
                raise RuntimeError(
                    "PROMETHEUS_MULTIPROC_DIR is required when WEB_CONCURRENCY exceeds 1"
                )
            metrics_dir = Path(raw_path).resolve()
            if not metrics_dir.is_dir():
                raise RuntimeError("PROMETHEUS_MULTIPROC_DIR must be an existing directory")
            sock = config.bind_socket()
            _PrometheusMultiprocess(config, sockets=[sock], metrics_dir=metrics_dir).run()
        else:
            server.run()
    except KeyboardInterrupt:
        pass

    if config.workers == 1 and not server.started:
        return STARTUP_FAILURE
    return 0


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
    if len(sys.argv) == 2 and sys.argv[1] == "_serve-api":
        raise SystemExit(_run_uvicorn())

    role = os.environ.get("CLAWDI_PROCESS_ROLE", API_ROLE).strip() or API_ROLE

    if role == API_ROLE:
        raise SystemExit(_run_api_with_drain())
    if role == CHANNELS_WORKER_ROLE:
        _exec(["python", "-m", "app.workers.channels"])
    if role == EMBEDDING_WORKER_ROLE:
        _exec(["python", "-m", "app.workers.embedding"])

    print(
        f"Unsupported CLAWDI_PROCESS_ROLE={role!r}; expected "
        f"{API_ROLE!r}, {CHANNELS_WORKER_ROLE!r}, or {EMBEDDING_WORKER_ROLE!r}.",
        file=sys.stderr,
    )
    raise SystemExit(64)


if __name__ == "__main__":
    main()
