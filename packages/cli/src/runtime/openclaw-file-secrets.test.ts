import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	gcOpenClawFileSecrets,
	openClawCredentialGeneration,
	openClawFileSecretEnvironmentKeys,
	projectOpenClawProviderFileSecrets,
} from "./openclaw-file-secrets";
import { openClawConfigCanHotReload } from "./openclaw-warm-gateway";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenClaw file credentials", () => {
	test("writes private credentials and rotates the config path without embedding values", () => {
		const home = mkdtempSync(join(tmpdir(), "clawdi-file-credentials-"));
		roots.push(home);
		const input = JSON.stringify({
			models: {
				providers: {
					clawdi: { apiKey: { source: "env", provider: "default", id: "CLAWDI_AI_API_KEY" } },
				},
			},
		});
		const first = JSON.parse(
			projectOpenClawProviderFileSecrets(
				input,
				{ CLAWDI_AI_API_KEY: "key-one", UNRELATED_SECRET: "never-copy" },
				home,
			),
		);
		const path = first.secrets.providers["clawdi-runtime"].path;
		expect(first.models.providers.clawdi.apiKey).toEqual({
			source: "file",
			provider: "clawdi-runtime",
			id: "/CLAWDI_AI_API_KEY",
		});
		expect(JSON.stringify(first)).not.toContain("key-one");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ CLAWDI_AI_API_KEY: "key-one" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(home, ".clawdi", "runtime-credentials")).mode & 0o777).toBe(0o700);
		const same = JSON.parse(
			projectOpenClawProviderFileSecrets(input, { CLAWDI_AI_API_KEY: "key-one" }, home),
		);
		expect(same.secrets.providers["clawdi-runtime"].path).toBe(path);
		const next = JSON.parse(
			projectOpenClawProviderFileSecrets(input, { CLAWDI_AI_API_KEY: "key-two" }, home),
		);
		expect(next.secrets.providers["clawdi-runtime"].path).not.toBe(path);
		// The old snapshot remains resolvable while a running gateway loads the candidate.
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ CLAWDI_AI_API_KEY: "key-one" });
		mkdirSync(join(home, ".openclaw"));
		writeFileSync(join(home, ".openclaw", "openclaw.json"), JSON.stringify(next));
		expect([...openClawFileSecretEnvironmentKeys(home)]).toEqual(["CLAWDI_AI_API_KEY"]);
	});

	test("native reload preferences retain the normal restart boundary", () => {
		const home = mkdtempSync(join(tmpdir(), "clawdi-reload-preferences-"));
		roots.push(home);
		mkdirSync(join(home, ".openclaw"));
		for (const mode of [undefined, "hybrid", "hot", "off", "restart"]) {
			writeFileSync(
				join(home, ".openclaw", "openclaw.json"),
				JSON.stringify({ gateway: { reload: { mode } } }),
			);
			expect(openClawConfigCanHotReload(home)).toBe(mode === undefined || mode === "hybrid");
		}
		writeFileSync(
			join(home, ".openclaw", "openclaw.json"),
			`{ gateway: { reload: { $include: 'reload.json5' } } }`,
		);
		expect(openClawConfigCanHotReload(home)).toBe(false);
	});

	test("does not withdraw unrelated env credentials", () => {
		const home = mkdtempSync(join(tmpdir(), "clawdi-file-credentials-"));
		roots.push(home);
		const input = JSON.stringify({
			models: {
				providers: { native: { apiKey: { source: "env", provider: "native", id: "USER_KEY" } } },
			},
		});
		expect(
			projectOpenClawProviderFileSecrets(input, { CLAWDI_AI_API_KEY: "managed-key" }, home),
		).toBe(input);
		expect([...openClawFileSecretEnvironmentKeys(home)]).toEqual([]);
	});
});

function credentialGeneration(home: string, key: string): { path: string; config: string } {
	const config = projectOpenClawProviderFileSecrets(
		JSON.stringify({
			models: { providers: { clawdi: { apiKey: { source: "env", id: "CLAWDI_AI_API_KEY" } } } },
		}),
		{ CLAWDI_AI_API_KEY: key },
		home,
	);
	return { path: JSON.parse(config).secrets.providers["clawdi-runtime"].path, config };
}

function credentialHome(): string {
	const home = mkdtempSync(join(tmpdir(), "clawdi-credential-gc-"));
	roots.push(home);
	mkdirSync(join(home, ".openclaw"));
	return home;
}

test("successful apply GC removes revoked generations, preserves rollback and stays idle on reuse", () => {
	const home = credentialHome();
	const configPath = join(home, ".openclaw", "openclaw.json");
	const first = credentialGeneration(home, "revoked");
	writeFileSync(configPath, first.config);
	gcOpenClawFileSecrets(home);
	const second = credentialGeneration(home, "rotated");
	writeFileSync(configPath, second.config);
	gcOpenClawFileSecrets(home);
	const third = credentialGeneration(home, "current");
	writeFileSync(configPath, third.config);
	writeFileSync(`${configPath}.bak`, first.config);
	gcOpenClawFileSecrets(home);
	expect(existsSync(first.path)).toBe(true);
	rmSync(`${configPath}.bak`);
	gcOpenClawFileSecrets(home);
	expect(existsSync(first.path)).toBe(false);
	for (let iteration = 0; iteration < 3; iteration++) gcOpenClawFileSecrets(home);
	expect(existsSync(second.path)).toBe(true);
	expect(existsSync(third.path)).toBe(true);
	writeFileSync(configPath, "{}");
	gcOpenClawFileSecrets(home);
	expect(existsSync(second.path)).toBe(false);
	expect(existsSync(third.path)).toBe(true);
	const fourth = credentialGeneration(home, "new-provider");
	writeFileSync(configPath, fourth.config);
	gcOpenClawFileSecrets(home);
	expect(existsSync(third.path)).toBe(false);
});

test("GC scans JSON5 includes and all native rollback snapshots, and deletes only owned files", () => {
	const home = credentialHome();
	const configPath = join(home, ".openclaw", "openclaw.json");
	const current = credentialGeneration(home, "current");
	writeFileSync(configPath, current.config);
	gcOpenClawFileSecrets(home);
	const retained = [];
	for (const suffix of [".bak", ".bak.1", ".bak.2", ".bak.3", ".bak.4", ".pre-update"]) {
		const generation = credentialGeneration(home, suffix);
		retained.push(generation.path);
		writeFileSync(configPath + suffix, generation.config);
	}
	const included = credentialGeneration(home, "included");
	writeFileSync(join(home, ".openclaw", "secrets.json5"), included.config);
	writeFileSync(configPath, "{ $include: ['secrets.json5'], gateway: {} }");
	const unrelated = join(home, ".clawdi", "runtime-credentials", "user.json");
	writeFileSync(unrelated, "user data");
	const discarded = credentialGeneration(home, "orphan");
	gcOpenClawFileSecrets(home);
	for (const path of [...retained, included.path, current.path, unrelated])
		expect(existsSync(path)).toBe(true);
	expect(existsSync(discarded.path)).toBe(false);
});

test("unreadable config and unsafe credential links defer GC without following or deleting them", () => {
	const home = credentialHome();
	const configPath = join(home, ".openclaw", "openclaw.json");
	const first = credentialGeneration(home, "first");
	writeFileSync(configPath, first.config);
	gcOpenClawFileSecrets(home);
	const orphan = credentialGeneration(home, "orphan");
	writeFileSync(configPath, "{ $include: 'missing.json5' }");
	expect(() => gcOpenClawFileSecrets(home)).toThrow();
	expect(existsSync(orphan.path)).toBe(true);
	writeFileSync(configPath, first.config);
	const link = join(home, ".clawdi", "runtime-credentials", `openclaw-${"a".repeat(64)}.json`);
	symlinkSync(orphan.path, link);
	expect(() => gcOpenClawFileSecrets(home)).toThrow("unsafe file identity");
	expect(existsSync(orphan.path)).toBe(true);
});

test("upgrade GC retains the pre-apply generation even when multiple candidates are newer", () => {
	const home = credentialHome();
	const configPath = join(home, ".openclaw", "openclaw.json");
	const running = credentialGeneration(home, "running");
	writeFileSync(configPath, running.config);
	const before = openClawCredentialGeneration(home);
	const candidates = ["failed", "provider-only", "provider-and-channel"].map((key) =>
		credentialGeneration(home, key),
	);
	const current = credentialGeneration(home, "committed");
	writeFileSync(configPath, current.config);
	gcOpenClawFileSecrets(home, before);
	expect(existsSync(running.path)).toBe(true);
	expect(existsSync(current.path)).toBe(true);
	for (const candidate of candidates) expect(existsSync(candidate.path)).toBe(false);
	gcOpenClawFileSecrets(home, openClawCredentialGeneration(home));
	expect(existsSync(running.path)).toBe(true);
	const next = credentialGeneration(home, "next");
	writeFileSync(configPath, next.config);
	gcOpenClawFileSecrets(home, openClawCredentialGeneration(home));
	expect(existsSync(running.path)).toBe(false);
});

test("GC re-reads references published after its initial scan before unlinking", () => {
	const home = credentialHome();
	const configPath = join(home, ".openclaw", "openclaw.json");
	const current = credentialGeneration(home, "current-race");
	const candidate = credentialGeneration(home, "newly-committed");
	writeFileSync(configPath, current.config);
	const original = filesystem.readdirSync;
	const spy = spyOn(filesystem, "readdirSync").mockImplementation(
		new Proxy(original, {
			apply(target, receiver, args) {
				writeFileSync(configPath, candidate.config);
				return Reflect.apply(target, receiver, args);
			},
		}),
	);
	try {
		gcOpenClawFileSecrets(home);
		expect(existsSync(candidate.path)).toBe(true);
	} finally {
		spy.mockRestore();
	}
});

// The official writer takes this same exclusive sidecar before SecretRef
// preflight and publication (openclaw/openclaw@3a9d69d config/write-lock.ts).
test("GC and native reference publication exclude each other at the unlink boundary", () => {
	const home = credentialHome();
	const configPath = join(home, ".openclaw", "openclaw.json");
	const lockPath = `${configPath}.lock`;
	const current = credentialGeneration(home, "current-locked");
	const candidate = credentialGeneration(home, "native-reference");
	writeFileSync(configPath, current.config);
	const original = filesystem.unlinkSync;
	let blocked = false;
	const spy = spyOn(filesystem, "unlinkSync").mockImplementation((path) => {
		if (String(path).endsWith(candidate.path.split("/").at(-1) ?? "")) {
			// Attempt precisely after the last CAS and before credential removal.
			expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
			expect(() => filesystem.openSync(lockPath, "wx", 0o600)).toThrow();
			blocked = true;
		}
		return original(path);
	});
	try {
		gcOpenClawFileSecrets(home);
		expect(blocked).toBe(true);
		expect(readFileSync(configPath, "utf8")).toBe(current.config);
		expect(existsSync(lockPath)).toBe(false);
	} finally {
		spy.mockRestore();
	}
	// In the reverse ordering the writer owns the lock, so GC must defer.
	const published = credentialGeneration(home, "published-before-gc");
	const writer = filesystem.openSync(lockPath, "wx", 0o600);
	try {
		writeFileSync(
			writer,
			JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
		);
		expect(() => gcOpenClawFileSecrets(home)).toThrow();
		writeFileSync(configPath, published.config);
		expect(existsSync(published.path)).toBe(true);
	} finally {
		filesystem.closeSync(writer);
		filesystem.unlinkSync(lockPath);
	}
	gcOpenClawFileSecrets(home);
	expect(existsSync(published.path)).toBe(true);
	expect(existsSync(lockPath)).toBe(false);
});
