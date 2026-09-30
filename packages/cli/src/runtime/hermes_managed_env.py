"""Project platform-owned credentials into the default Hermes profile via its native API."""

import contextlib
import fcntl
import hashlib
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")


def fingerprint(value):
    return hashlib.sha256(value.encode()).hexdigest()


def write_receipt(path, records, pending, needs_refresh):
    fd, temporary = tempfile.mkstemp(prefix=".hermes-env-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(
                {
                    "version": 1,
                    "fields": records,
                    "pending": sorted(pending),
                    "needsRefresh": needs_refresh,
                },
                handle,
            )
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def reconcile(desired, acknowledge=False):
    from hermes_cli import config

    if not isinstance(desired, dict) or any(
        not ENV_KEY.fullmatch(key)
        or not isinstance(value, str)
        or not value
        or not value.isascii()
        or "\n" in value
        or "\r" in value
        for key, value in desired.items()
    ):
        raise ValueError("Invalid profile environment")
    home = Path.home() / ".hermes"
    env_path = config.get_env_path()
    if env_path != home / ".env" or home.resolve() != home or env_path.is_symlink():
        raise ValueError("Refusing non-default profile environment")
    directory = Path.home() / ".clawdi" / "runtime"
    path = directory / "hermes-managed-env.json"
    if (
        directory.resolve() != directory
        or path.is_symlink()
        or (directory / "hermes-managed-env.lock").is_symlink()
    ):
        raise ValueError("Refusing symlinked environment ownership")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "hermes-managed-env.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        receipt = (
            json.loads(path.read_text())
            if path.exists()
            else {"version": 1, "fields": {}}
        )
        records = receipt.get("fields")
        pending_fields = receipt.get("pending", [])
        needs_refresh = receipt.get("needsRefresh", False)
        if (
            receipt.get("version") != 1
            or not isinstance(records, dict)
            or any(
                not ENV_KEY.fullmatch(key)
                or not isinstance(hashes, list)
                or not hashes
                or any(
                    not isinstance(h, str) or not DIGEST.fullmatch(h) for h in hashes
                )
                for key, hashes in records.items()
            )
        ):
            raise ValueError("Invalid profile environment ownership")
        if not isinstance(pending_fields, list) or any(
            key not in records for key in pending_fields
        ):
            raise ValueError("Invalid pending environment ownership")
        if not isinstance(needs_refresh, bool):
            raise ValueError("Invalid environment refresh state")
        pending = set(pending_fields)
        if acknowledge:
            if pending:
                raise ValueError(
                    "Cannot acknowledge incomplete native environment persistence"
                )
            if records and needs_refresh:
                write_receipt(path, records, pending, False)
            elif not records:
                path.unlink(missing_ok=True)
            return {"changed": False, "conflicts": []}
        original_pending = set(pending)
        original_refresh = needs_refresh
        original = {key: list(hashes) for key, hashes in records.items()}
        changed = needs_refresh
        conflicts = []
        for key in sorted(set(records) | set(desired)):
            current = config.load_env().get(key)
            prior = records.get(key, [])
            owned = current is not None and fingerprint(current) in prior
            if key not in desired:
                if owned:
                    require_writable = getattr(config, "require_env_writable", None)
                    if require_writable:
                        require_writable(key, "remove")
                    needs_refresh = True
                    pending.add(key)
                    write_receipt(path, records, pending, needs_refresh)
                    config.remove_env_value(key)
                    if key in config.load_env():
                        raise ValueError("Native environment removal failed")
                    changed = True
                changed = changed or key in pending
                pending.discard(key)
                records.pop(key, None)
                continue
            value = desired[key]
            if current and current != value and not owned:
                conflicts.append(key)
                pending.discard(key)
                records.pop(key, None)
                continue
            digest = fingerprint(value)
            if current != value:
                require_writable = getattr(config, "require_env_writable", None)
                if require_writable:
                    require_writable(key, "set")
                # Write ahead: a native write failure cannot lose rotation/removal ownership.
                records[key] = sorted(set(prior + [digest]))
                pending.add(key)
                needs_refresh = True
                write_receipt(path, records, pending, needs_refresh)
                config.save_env_value(key, value)
                if config.load_env().get(key) != value:
                    raise ValueError("Native environment persistence failed")
                changed = True
            elif key in pending:
                changed = True
            pending.discard(key)
            records[key] = [digest]
        if (records or needs_refresh) and (
            records != original
            or pending != original_pending
            or needs_refresh != original_refresh
            or not path.exists()
        ):
            write_receipt(path, records, pending, needs_refresh)
        elif not records and not needs_refresh:
            path.unlink(missing_ok=True)
        return {"changed": changed, "conflicts": conflicts}


try:
    payload = json.load(sys.stdin)
    sys.path.insert(0, sys.argv[1])
    with (
        contextlib.redirect_stdout(io.StringIO()),
        contextlib.redirect_stderr(io.StringIO()),
    ):
        result = reconcile(payload, "--acknowledge" in sys.argv[2:])
    print(json.dumps(result))
except Exception:
    # Native errors may contain credentials; expose only a fixed failure boundary.
    sys.exit(1)
