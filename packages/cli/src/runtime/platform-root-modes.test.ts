import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cacheRuntimeLastGoodManifest, convergeRuntimeManifest } from "./manifest";
import { normalizeHostedRuntimeBundleV2 } from "./manifest-source";
import type { RuntimePaths } from "./paths";
import { ensureRuntimeStateDirs } from "./state";

const ROOT_MODE_TEST_SECRET_REF = "secret://runtime/root-modes/test-secret";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-platform-root-modes-"));
	roots.push(root);
	return root;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function statSummary(path: string): { mode: number; uid: number } {
	const stat = statSync(path);
	return { mode: stat.mode & 0o777, uid: stat.uid };
}

test("never chmods the four platform roots that child writes touch", async () => {
	const root = tempRoot();
	const home = join(root, "home", "clawdi");
	const state = join(root, "state");
	const run = join(root, "run");
	const systemdSystemRoot = join(run, "systemd", "system");
	const openclaw = join(home, ".local", "bin", "openclaw");
	mkdirSync(dirname(openclaw), { recursive: true });
	mkdirSync(join(home, ".openclaw"), { recursive: true });
	writeFileSync(
		openclaw,
		`#!/bin/sh
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"%s"}]\\n' "$HOME/.openclaw/workspace"
elif [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' '2026.7.1'
fi
exit 0
`,
	);
	chmodSync(openclaw, 0o755);

	const originalEnv = { ...process.env };
	process.env.HOME = home;
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	const runtimeUid = process.getuid?.() ?? 1_000;
	const runtimeGid = process.getgid?.() ?? 1_000;
	process.env.CLAWDI_RUNTIME_USER = String(runtimeUid);
	process.env.CLAWDI_SERVICE_STATE_DIR = state;
	process.env.CLAWDI_RUN_DIR = run;
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = systemdSystemRoot;
	process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";

	try {
		const fixture = JSON.parse(
			readFileSync(
				join(import.meta.dir, "../../../../test-fixtures/runtime-bundle-v2.golden.json"),
				"utf-8",
			),
		) as Record<string, unknown>;
		const manifest = fixture.manifest as Record<string, unknown>;
		const runtimes = manifest.runtimes as Record<string, Record<string, unknown>>;
		const openclawRuntime = runtimes.openclaw;
		openclawRuntime.providerMode = "unmanaged";
		openclawRuntime.provider_ids = [];
		delete openclawRuntime.primary_model;
		manifest.providers = {};
		manifest.skills = { entries: {} };
		// A recoverable secret ensures writeLastGoodSecretValues persists the
		// cache file directly inside the cache platform root.
		const openclawRun = openclawRuntime.run as Record<string, unknown>;
		openclawRuntime.run = {
			...openclawRun,
			secretEnv: {
				...(openclawRun.secretEnv as Record<string, unknown>),
				ROOT_MODE_TEST_SECRET: ROOT_MODE_TEST_SECRET_REF,
			},
		};
		fixture.secretValues = {
			"secret://clawdi/auth-token": "runtime-auth-token-root-modes",
			"secret://runtime/openclaw/gateway-token": "gateway-token-root-modes",
			"secret://tool.codex.apiKey": "codex-provider-key-root-modes",
			[ROOT_MODE_TEST_SECRET_REF]: "root-modes-secret-value",
		};

		const { getRuntimePaths } = await import("./paths");
		const paths: RuntimePaths = getRuntimePaths();
		const layout = [
			{ path: paths.configurationRoot, mode: 0o700, label: "configuration" },
			{ path: paths.serviceStateRoot, mode: 0o700, label: "service state" },
			{ path: paths.cacheRoot, mode: 0o700, label: "cache" },
			{ path: paths.runRoot, mode: 0o711, label: "runtime" },
		];
		// Mirror the tenant image: systemd directory directives pre-create the
		// four platform roots with their canonical modes before the CLI runs.
		for (const entry of layout) {
			mkdirSync(entry.path, { recursive: true, mode: entry.mode });
			chmodSync(entry.path, entry.mode);
		}

		ensureRuntimeStateDirs(paths);
		const before = new Map(layout.map((entry) => [entry.path, statSummary(entry.path)]));

		const load = normalizeHostedRuntimeBundleV2(fixture);
		load.applyContext = {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: 2,
				manifestETag: '"manifest-root-modes"',
				applyReceiptId: "apply-receipt-root-modes-0001",
				bootNonce: "boot-nonce-root-modes-0000001",
			},
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer", token: "bootstrap-bearer-root-modes" },
			},
		};
		const result = convergeRuntimeManifest(load, paths, {
			hostedRuntimeContract: {
				expectedIdentity: {
					home,
					user: String(runtimeUid),
					uid: runtimeUid,
					gid: runtimeGid,
				},
				resolveUserIdentity: () => ({ uid: runtimeUid, gid: runtimeGid }),
			},
		});
		expect(result.installErrors).toEqual([]);
		// The convergence loop just ran writeLiveSyncEnvironmentIndex (into
		// the configuration root) and writeLastGoodSecretValues (into the
		// cache root); the explicit call re-runs the secret cache writer.
		cacheRuntimeLastGoodManifest(result.manifest, paths, load.secretValues);

		for (const entry of layout) {
			const expected = before.get(entry.path);
			if (!expected) throw new Error(`missing before snapshot for ${entry.path}`);
			expect(statSummary(entry.path)).toEqual(expected);
			expect(statSummary(entry.path).mode).toBe(entry.mode);
			expect(statSummary(entry.path).uid).toBe(runtimeUid);
		}
		expect(statSync(paths.liveSyncEnvironmentIndex).mode & 0o777).toBe(0o644);
		expect(statSync(paths.managedSecretCacheFile).mode & 0o777).toBe(0o600);
	} finally {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	}
});
