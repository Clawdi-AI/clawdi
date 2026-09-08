import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERMES_NATIVE_CREDENTIALS_HELPER } from "./hermes-native-credentials";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "clawdi-native-auth-"));
	roots.push(home);
	const app = join(home, ".hermes", "hermes-agent");
	mkdirSync(join(app, "hermes_cli"), { recursive: true });
	mkdirSync(join(app, "agent"), { recursive: true });
	// Test double for the audited native disk API. Only the owned row may be
	// supplied; omitted siblings must be preserved by the native writer.
	writeFileSync(
		join(app, "hermes_cli", "auth.py"),
		`
import json, os
from pathlib import Path
path = Path(os.environ["HERMES_HOME"]) / "auth.json"
class AuthError(Exception):
    pass
def resolve_provider(provider):
    return {"opencode": "opencode-zen", "zen": "opencode-zen", "claude": "anthropic"}.get(provider, provider)
def read_credential_pool(provider_id=None):
    pool = json.loads(path.read_text()) if path.exists() else {}
    return pool if provider_id is None else pool.get(provider_id, [])
def write_credential_pool(provider_id, entries, *, removed_ids=(), status_cleared_ids=()):
    assert all(e["id"] == "clawdi-native-api-key" for e in entries)
    pool = read_credential_pool()
    prior = {e["id"]: e for e in pool.get(provider_id, []) if e["id"] not in removed_ids}
    prior.update({e["id"]: e for e in entries})
    pool[provider_id] = list(prior.values())
    path.write_text(json.dumps(pool))
    if (path.parent / "fail-after-write").exists():
        raise RuntimeError("private upstream diagnostic " + str(entries))
`,
	);
	writeFileSync(
		join(app, "hermes_cli", "runtime_provider.py"),
		`
import os
from pathlib import Path
def _get_named_custom_provider(provider):
    return {"name": provider} if (Path(os.environ["HERMES_HOME"]) / "custom-alias").exists() else None
`,
	);
	writeFileSync(
		join(app, "agent", "credential_pool.py"),
		`
class PooledCredential:
    def __init__(self, **values):
        self.values = values
    def to_dict(self):
        return {key: value for key, value in self.values.items() if key != "provider"}
`,
	);
	const auth = join(home, ".hermes", "auth.json");
	const journal = join(home, ".clawdi", "runtime", "hermes-native-credentials.json");
	const userEntry = {
		id: "personal",
		source: "manual",
		priority: 0,
		access_token: "personal-key",
		last_status: "exhausted",
	};
	writeFileSync(
		auth,
		JSON.stringify({
			anthropic: [userEntry],
			openai: [{ id: "unrelated", access_token: "other-key" }],
		}),
	);
	function run(
		providers: Array<{ providerId: string; apiKey: string; baseUrl: string }>,
		strategies: Record<string, unknown>,
		selectedProvider?: string,
	) {
		return spawnSync("python3", ["-c", HERMES_NATIVE_CREDENTIALS_HELPER, app], {
			encoding: "utf8",
			timeout: 10_000,
			env: { ...process.env, HOME: home, HERMES_HOME: join(home, ".hermes") },
			input: JSON.stringify({ providers, strategies, previousProviderIds: [], selectedProvider }),
		});
	}
	return {
		home,
		auth,
		journal,
		userEntry,
		run,
		pool: () => JSON.parse(readFileSync(auth, "utf8")),
	};
}
const credential = {
	providerId: "anthropic",
	apiKey: "connected-key",
	baseUrl: "https://api.anthropic.com",
};

test("native credentials take priority, rotate only their row, and retain cooldown until rotation", () => {
	const f = fixture();
	const initial = f.run([credential], { anthropic: "random" });
	expect(initial.status).toBe(0);
	expect(JSON.parse(initial.stdout)).toEqual({
		changed: true,
		selectedProvider: null,
		strategyUpdates: { anthropic: { exists: true, value: "fill_first" } },
	});
	const connected = f.pool();
	expect(connected.anthropic.find((row: { id: string }) => row.id === "personal")).toEqual(
		f.userEntry,
	);
	const own = connected.anthropic.find((row: { id: string }) => row.id === "clawdi-native-api-key");
	expect(own.priority).toBeLessThan(f.userEntry.priority);
	own.last_status = "exhausted";
	writeFileSync(f.auth, JSON.stringify(connected));
	const repeat = f.run([credential], { anthropic: "fill_first" });
	expect(repeat.status).toBe(0);
	expect(JSON.parse(repeat.stdout).changed).toBe(false);
	const rotated = f.run([{ ...credential, apiKey: "rotated-key" }], { anthropic: "fill_first" });
	expect(rotated.status).toBe(0);
	const pool = f.pool();
	expect(
		pool.anthropic.find((row: { id: string }) => row.id === "clawdi-native-api-key"),
	).toMatchObject({ access_token: "rotated-key", base_url: credential.baseUrl });
	expect(pool.anthropic.find((row: { id: string }) => row.id === "personal")).toEqual(f.userEntry);
	expect(pool.openai).toEqual(connected.openai);
	expect(readFileSync(f.journal, "utf8")).not.toContain("key");
});

test("uses the native auth identity for selected aliases and rejects alias pool keys", () => {
	const f = fixture();
	const zen = {
		providerId: "opencode-zen",
		apiKey: "zen-key",
		baseUrl: "https://opencode.ai/zen/v1",
	};
	const result = f.run([zen], { "opencode-zen": "random" }, "opencode");
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({
		selectedProvider: "opencode-zen",
		strategyUpdates: { "opencode-zen": { exists: true, value: "fill_first" } },
	});
	expect(f.pool()["opencode-zen"]).toHaveLength(1);
	expect(f.pool().opencode).toBeUndefined();
	writeFileSync(join(f.home, ".hermes", "custom-alias"), "1");
	const custom = f.run([zen], { "opencode-zen": "fill_first" }, "opencode");
	expect(custom.status).toBe(0);
	expect(JSON.parse(custom.stdout).selectedProvider).toBeNull();
	const saved = readFileSync(f.auth, "utf8");
	expect(f.run([{ ...zen, providerId: "opencode" }], {}).status).toBe(1);
	expect(readFileSync(f.auth, "utf8")).toBe(saved);
});

test("removal recovers uncommitted ownership and retries strategy restoration", () => {
	const f = fixture();
	writeFileSync(join(f.home, ".hermes", "fail-after-write"), "1");
	const failed = f.run([credential], { anthropic: "round_robin" });
	expect(failed.status).toBe(1);
	expect(failed.stdout + failed.stderr).not.toContain(credential.apiKey);
	expect(existsSync(f.journal)).toBe(true);
	rmSync(join(f.home, ".hermes", "fail-after-write"));
	const removal = f.run([], { anthropic: "fill_first" });
	expect(removal.status).toBe(0);
	expect(JSON.parse(removal.stdout).strategyUpdates).toEqual({
		anthropic: { exists: true, value: "round_robin" },
	});
	expect(f.pool().anthropic).toEqual([f.userEntry]);
	expect(existsSync(f.journal)).toBe(true);
	const completed = f.run([], { anthropic: "round_robin" });
	expect(completed.status).toBe(0);
	expect(JSON.parse(completed.stdout).changed).toBe(false);
	expect(existsSync(f.journal)).toBe(false);
});

test("conflicting or malformed native rows are preserved without adoption", () => {
	const f = fixture();
	const original = JSON.stringify({ anthropic: [{ ...f.userEntry, id: "clawdi-native-api-key" }] });
	writeFileSync(f.auth, original);
	expect(f.run([credential], {}).status).toBe(1);
	expect(readFileSync(f.auth, "utf8")).toBe(original);
	expect(existsSync(f.journal)).toBe(false);
	const malformed = JSON.stringify({
		anthropic: [{ source: "manual", access_token: "unidentified-key" }],
	});
	writeFileSync(f.auth, malformed);
	expect(f.run([credential], {}).status).toBe(1);
	expect(readFileSync(f.auth, "utf8")).toBe(malformed);
	expect(existsSync(f.journal)).toBe(false);
});
