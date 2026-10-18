#!/usr/bin/env python3
"""Host cron entrypoint. Only disposable containers access repository credentials.

Configuration/credentials are separate from the production pgBackRest config.
All command diagnostics stay private and are discarded, including on failure.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

HERE = Path(__file__).resolve().parent
HOST_LOCK = Path("/run/lock/clawdi-postgres-drill.lock")
IDENTIFIER = re.compile(r"[a-zA-Z0-9_-]+")
LABEL = re.compile(r"\d{8}-\d{6}F(?:_\d{8}-\d{6}[DI])?")
ENV_KEYS = {
    "PGBACKREST_STANZA",
    "PGBACKREST_REPO1_TYPE",
    "PGBACKREST_REPO1_PATH",
    "PGBACKREST_REPO1_S3_BUCKET",
    "PGBACKREST_REPO1_S3_ENDPOINT",
    "PGBACKREST_REPO1_S3_REGION",
    "PGBACKREST_REPO1_S3_URI_STYLE",
    "PGBACKREST_REPO1_S3_KEY",
    "PGBACKREST_REPO1_S3_KEY_SECRET",
    "PGBACKREST_REPO1_CIPHER_TYPE",
    "PGBACKREST_REPO1_CIPHER_PASS",
}


def utc(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def publish(path: Path, value: dict) -> None:
    temporary = path.with_name(f".{path.name}.{uuid4().hex}")
    try:
        with temporary.open("x", encoding="utf-8") as file:
            json.dump(value, file)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        temporary.chmod(0o644)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def private_file(path: str) -> Path:
    result = Path(path).resolve(strict=True)
    if result.stat().st_mode & 0o077:
        raise ValueError("credential file must be private")
    return result


def repository_file(path: str, stanza: str) -> Path:
    result = private_file(path)
    values = {}
    for line in result.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, value = line.split("=", 1)
        if key not in ENV_KEYS or key in values or not value:
            raise ValueError("unexpected repository setting")
        values[key] = value
    if values.get("PGBACKREST_STANZA") != stanza:
        raise ValueError("repository stanza mismatch")
    if values.get("PGBACKREST_REPO1_TYPE") != "s3":
        raise ValueError("drills require S3 repository settings")
    return result


class Runner:
    def __init__(self, config: dict):
        self.config = config
        self.stanza = config["stanza"]
        if not IDENTIFIER.fullmatch(self.stanza):
            raise ValueError("invalid stanza")
        if not IDENTIFIER.fullmatch(config["database"]):
            raise ValueError("invalid database")
        self.image = config["image"]
        if not re.fullmatch(r"[a-zA-Z0-9./:_-]+@sha256:[0-9a-f]{64}", self.image):
            raise ValueError("image must be digest pinned")
        self.status_dir = Path(config["status_dir"]).resolve(strict=True)
        self.name = f"pg-drill-{self.stanza}-{uuid4().hex[:12]}"
        self.volume = self.name
        timeout = int(config.get("timeout_seconds", 14400))
        if not 60 <= timeout <= 14400:
            raise ValueError("timeout must be between one minute and four hours")
        self.remaining = time.monotonic() + timeout
        self.resources = [
            "--cpus=2",
            "--memory=2g",
            "--pids-limit=256",
            "--blkio-weight=100",
            "--security-opt=no-new-privileges",
            "--log-driver=none",
            "--tmpfs=/var/lib/postgresql:rw,size=1m",
        ]
        self.phase = "preflight"

    def cleanup_previous(self) -> None:
        """Called only while holding the host-wide lock, before starting work.

        The fixed-length hex suffix distinguishes Cloud from the similarly
        named Hosted stanza. Never trust Docker's substring filters alone.
        """
        prefix = f"pg-drill-{self.stanza}-"
        pattern = re.compile(rf"{re.escape(prefix)}[0-9a-f]{{12}}")
        containers = self.command(
            [
                "docker",
                "ps",
                "--all",
                "--filter",
                f"name={prefix}",
                "--format",
                "{{.Names}}",
            ]
        )
        for name in containers.splitlines():
            if pattern.fullmatch(name) and name != self.name:
                self.command(["docker", "rm", "--force", "--volumes", name])
        volumes = self.command(
            [
                "docker",
                "volume",
                "ls",
                "--filter",
                f"name={prefix}",
                "--format",
                "{{.Name}}",
            ]
        )
        for name in volumes.splitlines():
            if pattern.fullmatch(name) and name != self.volume:
                self.command(["docker", "volume", "rm", name])

    def command(self, args: list[str], *, stdin: str | None = None) -> str:
        timeout = max(1, self.remaining - time.monotonic())
        result = subprocess.run(
            args,
            input=stdin,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        if result.returncode:
            raise RuntimeError("command failed")
        return result.stdout.strip()

    def container(
        self,
        args: list[str],
        *,
        env_file: Path | None = None,
        stdin: str | None = None,
        offline: bool = False,
        user: str | None = None,
    ) -> str:
        cmd = ["docker", "run", "--rm", "--name", self.name, *self.resources]
        if offline:
            cmd += ["--network=none"]
        if env_file:
            cmd += ["--env-file", str(env_file)]
        if user:
            cmd += ["--user", user]
        cmd += ["--mount", f"type=volume,src={self.volume},dst=/scratch"]
        if stdin is not None:
            cmd += ["--interactive"]
        return self.command(
            [*cmd, "--entrypoint", args[0], self.image, *args[1:]], stdin=stdin
        )

    def cleanup(self) -> bool:
        # Also runs after timeout/SIGTERM. Never remove anything not named by
        # this invocation; removing the container closes all scratch DB files.
        try:
            containers = subprocess.run(
                [
                    "docker",
                    "ps",
                    "--all",
                    "--filter",
                    f"name=^/{self.name}$",
                    "--format",
                    "{{.Names}}",
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=True,
            )
            if containers.stdout.strip() == self.name:
                subprocess.run(
                    ["docker", "rm", "--force", "--volumes", self.name],
                    capture_output=True,
                    timeout=60,
                    check=True,
                )
            volumes = subprocess.run(
                [
                    "docker",
                    "volume",
                    "ls",
                    "--filter",
                    f"name={self.volume}",
                    "--format",
                    "{{.Name}}",
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=True,
            )
            if self.volume in volumes.stdout.splitlines():
                subprocess.run(
                    ["docker", "volume", "rm", self.volume],
                    capture_output=True,
                    timeout=60,
                    check=True,
                )
            return True
        except (OSError, subprocess.SubprocessError):
            return False

    def metadata(self, env_file: Path) -> tuple[list, dict]:
        info = json.loads(
            self.container(
                [
                    "pgbackrest",
                    "--repo=1",
                    "--log-level-console=off",
                    "info",
                    "--output=json",
                ],
                env_file=env_file,
            )
        )
        listing = json.loads(
            self.container(
                [
                    "pgbackrest",
                    "--repo=1",
                    "--log-level-console=off",
                    "repo-ls",
                    "--recurse",
                    "--output=json",
                ],
                env_file=env_file,
            )
        )
        return info, listing

    def drill(self, status: dict) -> None:
        config = self.config
        env_file = repository_file(config["readonly_env"], self.stanza)
        target_epoch = int(time.time()) - 600
        status.update(source="repo1", target_epoch=target_epoch)
        target = utc(target_epoch)
        info, listing = self.metadata(env_file)
        stanza = next(item for item in info if item["name"] == self.stanza)
        candidates = [
            b
            for b in stanza["backup"]
            if b["error"] is False and b["timestamp"]["stop"] <= target_epoch
        ]
        backup = max(candidates, key=lambda b: b["timestamp"]["stop"])
        if not LABEL.fullmatch(backup["label"]):
            raise ValueError("invalid backup label")
        repo_size = sum(
            item.get("size", 0) for item in listing.values() if item["type"] == "file"
        )
        if repo_size <= 0:
            raise ValueError("empty repository")
        wal_limit = int(config.get("max_wal_bytes", 16 * 1024**3))
        if wal_limit <= 0:
            raise ValueError("invalid WAL budget")
        # Docker volumes live on DockerRootDir, which may differ from / or the
        # cron working directory. Include uncompressed restore + WAL + headroom.
        root = self.command(["docker", "info", "--format", "{{.DockerRootDir}}"])
        disk = shutil.disk_usage(root)
        scratch = int(backup["info"]["size"] * 1.2) + wal_limit
        if disk.free - scratch < max(disk.total // 4, 2 * repo_size):
            raise ValueError("insufficient scratch headroom")
        self.phase = "restore"
        self.container(
            ["bash", "-s", "--", target, backup["label"], str(wal_limit)],
            env_file=env_file,
            stdin=(HERE / "fetch.sh").read_text(),
        )
        self.phase = "checks"
        sanity = Path(config["sanity_sql"]).resolve(strict=True).read_text()
        # Supply SQL through stdin; neither it nor customer data appears in argv.
        self.container(
            ["sh", "-c", "cat > /scratch/sanity.sql"], offline=True, stdin=sanity
        )
        replayed = int(
            self.container(
                [
                    "bash",
                    "-s",
                    "--",
                    config["database"],
                    target,
                    str(int(config.get("max_target_lag_seconds", 3600))),
                ],
                offline=True,
                user="postgres",
                stdin=(HERE / "check.sh").read_text(),
            )
        )
        status.update(
            backup_label=backup["label"],
            replayed_at_epoch=replayed,
            rpo_seconds=max(0, int(time.time()) - replayed),
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    args = parser.parse_args()
    runner = None
    status = {}
    try:
        config = json.loads(args.config.read_text())
        if not config.get("enabled", False):
            return 0
        runner = Runner(config)
        started = time.time()
        status = {
            "schema": 1,
            "stanza": runner.stanza,
            "outcome": "running",
            "started_at_epoch": int(started),
        }
        path = runner.status_dir / f"{runner.stanza}.drill.json"
        # Fixed host path, independent of each stanza's status/config paths.
        with HOST_LOCK.open("a") as lock:
            wait_until = min(time.monotonic() + 300, runner.remaining)
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= wait_until:
                        status.update(
                            outcome="failed",
                            phase="lock_timeout",
                            finished_at_epoch=int(time.time()),
                            rto_seconds=round(time.time() - started, 2),
                        )
                        publish(path, status)
                        return 1
                    time.sleep(1)
            publish(path, status)

            def interrupted(_signum, _frame):
                raise TimeoutError("interrupted")

            signal.signal(signal.SIGTERM, interrupted)
            signal.signal(signal.SIGINT, interrupted)
            signal.signal(signal.SIGALRM, interrupted)
            signal.alarm(max(1, int(runner.remaining - time.monotonic())))
            try:
                runner.phase = "cleanup_previous"
                runner.cleanup_previous()
                runner.phase = "preflight"
                runner.drill(status)
                status["outcome"] = "success"
            except Exception as error:
                status.update(outcome="failed", phase=runner.phase)
                # The outer CLI boundary catches this normalized failure and
                # emits only a fixed message, never the exception or traceback.
                raise RuntimeError("Postgres restore drill failed") from error
            finally:
                signal.alarm(0)
                if not runner.cleanup():
                    status.update(outcome="failed", phase="cleanup")
                status.update(
                    finished_at_epoch=int(time.time()),
                    rto_seconds=round(time.time() - started, 2),
                )
                publish(path, status)
        return int(status["outcome"] != "success")
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        RuntimeError,
        subprocess.SubprocessError,
    ):
        # Never stringify exceptions: command stderr/config may contain secrets.
        print("Postgres restore drill failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
