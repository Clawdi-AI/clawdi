import { afterAll, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RuntimeManagedMutationPlan } from "./live-state-snapshot";
import * as actualSnapshot from "./live-state-snapshot";

const fsOriginals = {
	chmodSync: realFs.chmodSync,
	chownSync: realFs.chownSync,
	copyFileSync: realFs.copyFileSync,
	cpSync: realFs.cpSync,
	lchownSync: realFs.lchownSync,
	mkdirSync: realFs.mkdirSync,
	mkdtempSync: realFs.mkdtempSync,
	readFileSync: realFs.readFileSync,
	renameSync: realFs.renameSync,
	rmSync: realFs.rmSync,
	rmdirSync: realFs.rmdirSync,
	symlinkSync: realFs.symlinkSync,
	unlinkSync: realFs.unlinkSync,
	writeFileSync: realFs.writeFileSync,
};
const captureRuntimeLiveSnapshotOriginal = actualSnapshot.captureRuntimeLiveSnapshot;
const mutations: string[] = [];
let capturedPlan: RuntimeManagedMutationPlan | null = null;
let recording = false;

function record(path: realFs.PathOrFileDescriptor): void {
	if (!recording) return;
	if (typeof path === "number") return;
	if (typeof path === "string") mutations.push(resolve(path));
	else if (path instanceof URL) mutations.push(resolve(path.pathname));
	else mutations.push(resolve(path.toString()));
}

mock.module("node:fs", () => ({
	...realFs,
	chmodSync: (...args: Parameters<typeof realFs.chmodSync>) => {
		record(args[0]);
		return Reflect.apply(fsOriginals.chmodSync, realFs, args);
	},
	chownSync: (...args: Parameters<typeof realFs.chownSync>) => {
		record(args[0]);
		return Reflect.apply(fsOriginals.chownSync, realFs, args);
	},
	copyFileSync: (...args: Parameters<typeof realFs.copyFileSync>) => {
		record(args[1]);
		return Reflect.apply(fsOriginals.copyFileSync, realFs, args);
	},
	cpSync: (...args: Parameters<typeof realFs.cpSync>) => {
		record(args[1]);
		return Reflect.apply(fsOriginals.cpSync, realFs, args);
	},
	lchownSync: (...args: Parameters<typeof realFs.lchownSync>) => {
		record(args[0]);
		return Reflect.apply(fsOriginals.lchownSync, realFs, args);
	},
	mkdirSync: (...args: Parameters<typeof realFs.mkdirSync>) => {
		record(args[0]);
		return Reflect.apply(fsOriginals.mkdirSync, realFs, args);
	},
	mkdtempSync: (...args: Parameters<typeof realFs.mkdtempSync>) => {
		const result = Reflect.apply(fsOriginals.mkdtempSync, realFs, args);
		record(result);
		return result;
	},
	renameSync: (...args: Parameters<typeof realFs.renameSync>) => {
		record(args[0]);
		record(args[1]);
		return Reflect.apply(fsOriginals.renameSync, realFs, args);
	},
	rmSync: (...args: Parameters<typeof realFs.rmSync>) => {
		record(args[0]);
		return Reflect.apply(fsOriginals.rmSync, realFs, args);
	},
	rmdirSync: (...args: Parameters<typeof realFs.rmdirSync>) => {
		record(args[0]);
		return Reflect.apply(fsOriginals.rmdirSync, realFs, args);
	},
	symlinkSync: (...args: Parameters<typeof realFs.symlinkSync>) => {
		record(args[1]);
		return Reflect.apply(fsOriginals.symlinkSync, realFs, args);
	},
	unlinkSync: (...args: Parameters<typeof realFs.unlinkSync>) => {
		record(args[0]);
		return Reflect.apply(fsOriginals.unlinkSync, realFs, args);
	},
	writeFileSync: (...args: Parameters<typeof realFs.writeFileSync>) => {
		record(args[0]);
		return Reflect.apply(fsOriginals.writeFileSync, realFs, args);
	},
}));

mock.module("./live-state-snapshot", () => ({
	...actualSnapshot,
	captureRuntimeLiveSnapshot: (plan: RuntimeManagedMutationPlan) => {
		capturedPlan = plan;
		return captureRuntimeLiveSnapshotOriginal(plan);
	},
}));

function atomicTarget(path: string): string {
	const name = basename(path);
	const marker = name.indexOf(".tmp-");
	if (!name.startsWith(".") || marker <= 1) return path;
	return join(dirname(path), name.slice(1, marker));
}

function isOwnedMutation(path: string, targets: readonly string[]): boolean {
	return targets.some((target) => path === target || path.startsWith(`${target}/`));
}

afterAll(() => {
	recording = false;
	mock.restore();
});

test("keeps real Hosted converge mutations inside its exact root and runtime-user Plan", async () => {
	const root = fsOriginals.mkdtempSync(join(tmpdir(), "clawdi-mutation-parity-"));
	const home = join(root, "home", "clawdi");
	const state = join(root, "state");
	const run = join(root, "run");
	const systemdSystemRoot = join(run, "systemd", "system");
	const openclaw = join(home, ".openclaw", "bin", "openclaw");
	fsOriginals.mkdirSync(dirname(openclaw), { recursive: true });
	fsOriginals.writeFileSync(
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
	fsOriginals.chmodSync(openclaw, 0o755);

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
			fsOriginals.readFileSync(
				join(import.meta.dir, "../../../../test-fixtures/runtime-bundle-v2.golden.json"),
				"utf8",
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
		manifest.liveSync = { enabled: false, agents: [] };
		fixture.secretValues = {
			"secret://clawdi/auth-token": "runtime-auth-token-parity",
			"secret://runtime/openclaw/gateway-token": "gateway-token-parity",
			"secret://tool.codex.apiKey": "codex-provider-key-parity",
		};

		const { normalizeHostedRuntimeBundleV2 } = await import("./manifest-source");
		const { convergeRuntimeManifest } = await import("./manifest");
		const { getRuntimePaths } = await import("./paths");
		const { ensureRuntimeStateDirs } = await import("./state");
		const load = normalizeHostedRuntimeBundleV2(fixture);
		load.applyContext = {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: 2,
				manifestETag: '"manifest-parity"',
				applyReceiptId: "apply-receipt-parity-0001",
				bootNonce: "boot-nonce-parity-0000001",
			},
			cliPackageSpec: "clawdi@1.2.3-test",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest",
				auth: { type: "bearer", token: "bootstrap-bearer-parity" },
			},
		};

		const paths = getRuntimePaths();
		ensureRuntimeStateDirs(paths);
		recording = true;
		const result = convergeRuntimeManifest(load, paths, {
			cacheLastGood: false,
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
		recording = false;
		expect(result.installErrors).toEqual([]);
		expect(capturedPlan).not.toBeNull();
		if (!capturedPlan) throw new Error("runtime mutation plan was not captured");

		const rootTargets = capturedPlan.rootTargets.map((path) => resolve(path));
		const runtimeUserTargets = capturedPlan.runtimeUserTargets.map((path) => resolve(path));
		const metadataTargets = capturedPlan.metadataTargets.map((path) => resolve(path));
		expect(rootTargets.filter((target) => runtimeUserTargets.includes(target))).toEqual([]);

		const scopedMutations = [...new Set(mutations.map(atomicTarget))].filter((path) =>
			path.startsWith(`${root}/`),
		);
		const unexpected = scopedMutations.filter(
			(path) =>
				!isOwnedMutation(path, rootTargets) &&
				!isOwnedMutation(path, runtimeUserTargets) &&
				!isOwnedMutation(path, metadataTargets),
		);
		expect(unexpected).toEqual([]);
	} finally {
		recording = false;
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
		fsOriginals.rmSync(root, { recursive: true, force: true });
	}
});
