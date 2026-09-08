"""Reconcile owned API keys through Hermes' native credential-pool API.

Audited against NousResearch/hermes-agent@966637323e6f90864e069dbc12755934c2c86387.
The native writer locks auth.json and merges omitted siblings; removal requires
explicit removed_ids. Config updates belong to the caller's transaction, with a
credential-free write-ahead journal preserving strategy ownership across retries.
"""

import contextlib
import fcntl
import io
import json
import os
import re
import sys
import tempfile
from pathlib import Path

ENTRY_ID = "clawdi-native-api-key"
SOURCE = "manual:clawdi-native-api-key"
LABEL = "Clawdi BYOK"
PROVIDER_ID = re.compile(r"^[a-z][a-z0-9-]{0,119}$")


def owned(entry):
    return isinstance(entry, dict) and entry.get("id") == ENTRY_ID and entry.get("source") == SOURCE


def strategy_value(strategies, provider):
    return (
        {"exists": True, "value": strategies[provider]}
        if provider in strategies
        else {"exists": False}
    )


def owned_row(rows):
    if not isinstance(rows, list) or any(
        not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]
        for row in rows
    ):
        raise ValueError("Invalid native credential pool")
    matches = [row for row in rows if row["id"] == ENTRY_ID]
    if len(matches) > 1 or any(not owned(row) for row in matches):
        raise ValueError("Native credential ownership conflict")
    return matches[0] if matches else None


def selected_native_provider(selected):
    from hermes_cli.auth import AuthError, resolve_provider

    if selected is None:
        return None
    if not isinstance(selected, str):
        raise ValueError("Invalid selected provider")
    selected = selected.strip().lower()
    if not selected or selected == "auto":
        return None
    try:
        # Match load_pool's auth identity: models.dev aliases differ here.
        canonical = resolve_provider(selected)
    except AuthError:
        return None
    if canonical != selected:
        from hermes_cli.runtime_provider import has_named_custom_provider

        # Hermes lets a saved custom connection shadow a native alias.
        if has_named_custom_provider(selected):
            return None
    return canonical


def write_journal(path, records):
    descriptor, temporary = tempfile.mkstemp(prefix=".hermes-native-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump({"version": 1, "strategies": records}, handle)
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


def reconcile(payload):
    from agent.credential_pool import PooledCredential
    from hermes_cli.auth import read_credential_pool, resolve_provider, write_credential_pool

    desired = {}
    for item in payload["providers"]:
        provider = item["providerId"]
        if (
            not PROVIDER_ID.fullmatch(provider)
            or provider in desired
            or not isinstance(item["apiKey"], str)
            or not item["apiKey"].strip()
            or not isinstance(item["baseUrl"], str)
            or not item["baseUrl"].startswith("https://")
        ):
            raise ValueError("Invalid native credential input")
        if resolve_provider(provider) != provider:
            raise ValueError("Native credential identity is not canonical")
        desired[provider] = item
    selected = selected_native_provider(payload.get("selectedProvider"))
    strategies = payload["strategies"]
    if not isinstance(strategies, dict):
        raise ValueError("Invalid credential strategies")
    directory = Path.home() / ".clawdi" / "runtime"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / "hermes-native-credentials.json"
    with (directory / "hermes-native-credentials.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        journal = (
            json.loads(path.read_text()) if path.exists() else {"version": 1, "strategies": {}}
        )
        if journal.get("version") != 1 or not isinstance(journal.get("strategies"), dict):
            raise ValueError("Invalid native credential journal")
        records = journal["strategies"]
        for previous in records.values():
            if (
                not isinstance(previous, dict)
                or not isinstance(previous.get("exists"), bool)
                or (previous["exists"] and "value" not in previous)
            ):
                raise ValueError("Invalid native strategy ownership")
        original_records = records.copy()
        pool = read_credential_pool()
        if not isinstance(pool, dict):
            raise ValueError("Invalid native credential pool")
        discovered = {
            key
            for key, rows in pool.items()
            if isinstance(rows, list) and any(owned(row) for row in rows)
        }
        targets = set(desired) | set(payload["previousProviderIds"]) | set(records) | discovered
        for provider in targets:
            if not isinstance(provider, str) or not PROVIDER_ID.fullmatch(provider):
                raise ValueError("Invalid native provider identity")
        for provider in targets:
            owned_row(pool.get(provider, []))
        for provider in desired:
            current = strategy_value(strategies, provider)
            if provider not in records or current != {"exists": True, "value": "fill_first"}:
                records[provider] = current
        # Write ahead: a later auth/config failure cannot lose the user's strategy.
        if records and (not path.exists() or records != original_records):
            write_journal(path, records)
        persisted_records = records.copy()
        changed = False
        updates = {}
        for provider in sorted(targets):
            rows = read_credential_pool(provider)
            existing = owned_row(rows)
            if provider in desired:
                item = desired[provider]
                priorities = [row.get("priority", 0) for row in rows if not owned(row)]
                if any(
                    not isinstance(value, int) or isinstance(value, bool) for value in priorities
                ):
                    raise ValueError("Invalid native credential priority")
                priority = min(priorities, default=1) - 1
                rotated = (
                    existing is None
                    or existing.get("access_token") != item["apiKey"]
                    or existing.get("base_url") != item["baseUrl"]
                )
                entry = (
                    PooledCredential(
                        provider=provider,
                        id=ENTRY_ID,
                        label=LABEL,
                        auth_type="api_key",
                        priority=priority,
                        source=SOURCE,
                        access_token=item["apiKey"],
                        base_url=item["baseUrl"],
                    ).to_dict()
                    if rotated
                    else {**existing, "priority": priority, "label": LABEL}
                )
                if entry != existing:
                    # Omitted siblings are merged from disk, including concurrent
                    # key rotations; no snapshot of another credential is replayed.
                    write_credential_pool(
                        provider, [entry], status_cleared_ids=[ENTRY_ID] if rotated else []
                    )
                    changed = True
                if strategies.get(provider) != "fill_first":
                    updates[provider] = {"exists": True, "value": "fill_first"}
            else:
                if existing is not None:
                    write_credential_pool(provider, [], removed_ids=[ENTRY_ID])
                    changed = True
                previous = records.get(provider)
                if previous is not None:
                    current = strategy_value(strategies, provider)
                    if current == {"exists": True, "value": "fill_first"} and current != previous:
                        updates[provider] = previous
                    else:
                        # Config restoration already committed, or the user has
                        # replaced our strategy. Preserve their latest choice.
                        records.pop(provider)
        if records:
            if records != persisted_records:
                write_journal(path, records)
        else:
            path.unlink(missing_ok=True)
        return {
            "changed": changed or bool(updates),
            "strategyUpdates": updates,
            "selectedProvider": selected,
        }


def main():
    try:
        payload = json.load(sys.stdin)
        sys.path.insert(0, sys.argv[1])
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = reconcile(payload)
        print(json.dumps(result))
    except Exception:
        # Native diagnostics can contain credentials. Only the exit status
        # crosses this boundary; the caller supplies the fixed diagnostic.
        sys.exit(1)


if __name__ == "__main__":
    main()
