import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runtimeAppRoot } from "./manifest-install";
import { spawnRuntimeUserCommand } from "./runtime-user-command";

const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,119}$/);
const resultSchema = z.object({
	changed: z.boolean(),
	selectedProvider: providerId.nullable(),
	strategyUpdates: z.record(
		providerId,
		z.object({ exists: z.boolean(), value: z.unknown().optional() }),
	),
});

export interface HermesNativeCredentialsInput {
	home: string;
	workspaceRoot: string;
	providers: ReadonlyArray<{ providerId: string; apiKey: string; baseUrl: string }>;
	previousProviderIds: readonly string[];
	strategies: Readonly<Record<string, unknown>>;
	selectedProvider?: string;
}

// Audited against Hermes 96663732: the native writer merges omitted sibling
// rows under its auth lock and requires explicit removed_ids for deletion.
// This helper never rewrites config.yaml; the caller applies strategyUpdates
// through its existing config transaction. The journal contains no credentials.
export const HERMES_NATIVE_CREDENTIALS_HELPER = `
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile

ENTRY_ID = "clawdi-native-api-key"
SOURCE = "manual:clawdi-native-api-key"
LABEL = "Clawdi BYOK"
PROVIDER_ID = re.compile(r"^[a-z][a-z0-9-]{0,119}$")


def owned(entry):
    return isinstance(entry, dict) and entry.get("id") == ENTRY_ID and entry.get("source") == SOURCE


def strategy_value(strategies, provider):
    return {"exists": True, "value": strategies[provider]} if provider in strategies else {"exists": False}


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
    from hermes_cli.auth import AuthError, read_credential_pool, resolve_provider, write_credential_pool
    from agent.credential_pool import PooledCredential

    desired = {}
    for item in payload["providers"]:
        provider = item["providerId"]
        if (not PROVIDER_ID.fullmatch(provider) or provider in desired
                or not isinstance(item["apiKey"], str) or not item["apiKey"].strip()
                or not isinstance(item["baseUrl"], str) or not item["baseUrl"].startswith("https://")):
            raise ValueError("Invalid native credential input")
        if resolve_provider(provider) != provider:
            raise ValueError("Native credential identity is not canonical")
        desired[provider] = item
    selected = payload.get("selectedProvider")
    if selected and selected.strip().lower() != "auto":
        try:
            # Use the auth resolver used by load_pool, not models.dev aliases:
            # providers.normalize_provider collapses opencode-zen to opencode.
            canonical = resolve_provider(selected)
            if canonical != selected:
                # A saved custom provider can intentionally shadow a native
                # alias. Preserve that connection and its model overrides.
                from hermes_cli.runtime_provider import _get_named_custom_provider
                selected = None if _get_named_custom_provider(selected) is not None else canonical
            else:
                selected = canonical
        except AuthError:
            selected = None
    else:
        selected = None
    strategies = payload["strategies"]
    if not isinstance(strategies, dict):
        raise ValueError("Invalid credential strategies")
    directory = Path.home() / ".clawdi" / "runtime"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / "hermes-native-credentials.json"
    with (directory / "hermes-native-credentials.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        journal = json.loads(path.read_text()) if path.exists() else {"version": 1, "strategies": {}}
        if journal.get("version") != 1 or not isinstance(journal.get("strategies"), dict):
            raise ValueError("Invalid native credential journal")
        records = journal["strategies"]
        original_records = json.dumps(records, sort_keys=True)
        pool = read_credential_pool()
        if not isinstance(pool, dict):
            raise ValueError("Invalid native credential pool")
        discovered = {key for key, rows in pool.items() if isinstance(rows, list) and any(owned(row) for row in rows)}
        targets = set(desired) | set(payload["previousProviderIds"]) | set(records) | discovered
        for provider in targets:
            if not isinstance(provider, str) or not PROVIDER_ID.fullmatch(provider):
                raise ValueError("Invalid native provider identity")
        for provider in targets:
            rows = pool.get(provider, [])
            if not isinstance(rows, list) or any(
                not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]
                for row in rows
            ):
                raise ValueError("Invalid native credential pool")
            matches = [row for row in rows if isinstance(row, dict) and row.get("id") == ENTRY_ID]
            if len(matches) > 1 or any(not owned(row) for row in matches):
                raise ValueError("Native credential ownership conflict")
        for provider in desired:
            current = strategy_value(strategies, provider)
            if provider not in records or current != {"exists": True, "value": "fill_first"}:
                records[provider] = current
        # Write ahead: a later auth/config failure cannot lose the user's strategy.
        if records and (not path.exists() or json.dumps(records, sort_keys=True) != original_records):
            write_journal(path, records)
        persisted_records = json.dumps(records, sort_keys=True)
        changed = False
        updates = {}
        for provider in sorted(targets):
            rows = read_credential_pool(provider)
            if not isinstance(rows, list) or any(
                not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]
                for row in rows
            ):
                raise ValueError("Invalid native credential pool")
            matches = [row for row in rows if isinstance(row, dict) and row.get("id") == ENTRY_ID]
            if len(matches) > 1 or any(not owned(row) for row in matches):
                raise ValueError("Native credential ownership conflict")
            existing = matches[0] if matches else None
            if provider in desired:
                item = desired[provider]
                priorities = [row.get("priority", 0) for row in rows if isinstance(row, dict) and not owned(row)]
                if any(not isinstance(value, int) or isinstance(value, bool) for value in priorities):
                    raise ValueError("Invalid native credential priority")
                priority = min(priorities, default=1) - 1
                rotated = existing is None or existing.get("access_token") != item["apiKey"] or existing.get("base_url") != item["baseUrl"]
                entry = PooledCredential(
                    provider=provider, id=ENTRY_ID, label=LABEL, auth_type="api_key",
                    priority=priority, source=SOURCE, access_token=item["apiKey"], base_url=item["baseUrl"],
                ).to_dict() if rotated else {**existing, "priority": priority, "label": LABEL}
                if entry != existing:
                    # Omitted siblings are merged from disk, including concurrent
                    # key rotations; no snapshot of another credential is replayed.
                    write_credential_pool(provider, [entry], status_cleared_ids=[ENTRY_ID] if rotated else [])
                    changed = True
                if strategies.get(provider) != "fill_first":
                    updates[provider] = {"exists": True, "value": "fill_first"}
            else:
                if existing is not None:
                    write_credential_pool(provider, [], removed_ids=[ENTRY_ID])
                    changed = True
                previous = records.get(provider)
                if previous is not None:
                    if not isinstance(previous, dict) or not isinstance(previous.get("exists"), bool):
                        raise ValueError("Invalid native strategy ownership")
                    current = strategy_value(strategies, provider)
                    if current == {"exists": True, "value": "fill_first"} and current != previous:
                        updates[provider] = previous
                    else:
                        # Config restoration already committed, or the user has
                        # replaced our strategy. Preserve their latest choice.
                        records.pop(provider)
        if records:
            if json.dumps(records, sort_keys=True) != persisted_records:
                write_journal(path, records)
        else:
            path.unlink(missing_ok=True)
        return {"changed": changed or bool(updates), "strategyUpdates": updates, "selectedProvider": selected}


try:
    payload = json.load(sys.stdin)
    sys.path.insert(0, sys.argv[1])
    with contextlib.redirect_stdout(io.StringIO()):
        result = reconcile(payload)
    print(json.dumps(result))
except Exception:
    # Native exceptions can contain credentials. Only the exit status crosses
    # this boundary; the caller supplies the fixed diagnostic.
    sys.exit(1)
`;

export function reconcileHermesNativeCredentials(input: HermesNativeCredentialsInput) {
	if (
		input.providers.length === 0 &&
		input.previousProviderIds.length === 0 &&
		!existsSync(join(input.home, ".clawdi", "runtime", "hermes-native-credentials.json"))
	) {
		return {
			changed: false,
			strategyUpdates: {},
			selectedProvider: input.selectedProvider ?? null,
		};
	}
	const appRoot = runtimeAppRoot("hermes", input.home);
	if (!appRoot) throw new Error("Hermes application path is unavailable");
	const result = spawnRuntimeUserCommand(
		join(appRoot, ".venv", "bin", "python"),
		["-c", HERMES_NATIVE_CREDENTIALS_HELPER, appRoot],
		input.home,
		input.workspaceRoot,
		{
			environmentOverrides: { HERMES_HOME: join(input.home, ".hermes") },
			input: JSON.stringify({
				providers: input.providers,
				previousProviderIds: input.previousProviderIds,
				strategies: input.strategies,
				selectedProvider: input.selectedProvider,
			}),
			timeoutMs: 30_000,
			maxBufferBytes: 64 * 1024,
		},
	);
	if (result.status !== 0) throw new Error("Hermes native credential synchronization failed");
	try {
		return resultSchema.parse(JSON.parse(String(result.stdout)));
	} catch {
		throw new Error("Hermes native credential synchronization returned invalid output");
	}
}
