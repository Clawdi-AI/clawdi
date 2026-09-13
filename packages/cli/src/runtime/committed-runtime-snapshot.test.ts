import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
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
import { dirname, join } from "node:path";
import { z } from "zod";
import { commitRuntimeAppliedState, runtimeAppliedContentIdentity } from "../commands/runtime";
import { readRuntimeAppliedState, writeRuntimeAppliedState } from "./applied-state";
import { type RuntimeApplyContext, resolveRuntimeApplyGeneration } from "./apply-identity";
import { applyRuntimeBundleChannelsToManifestLoad } from "./channels";
import { runtimeConvergenceWithoutApply } from "./manifest-planning";
import { cacheRuntimeLastGoodManifest } from "./manifest-secrets";
import {
	loadCommittedRuntimeManifest,
	loadRuntimeManifest,
	migrateCommittedRuntimeSnapshot,
	parseHostedRuntimeBundleV2,
	runtimeSnapshotPath,
} from "./manifest-source";
import { getRuntimePaths, legacyRuntimeManifestPaths, type RuntimePaths } from "./paths";
import { ensureRuntimeStateDirs } from "./state";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(() => {
	process.env = { ...originalEnv };
	globalThis.fetch = originalFetch;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(allowOfflineBoot = false) {
	const root = mkdtempSync(join(tmpdir(), "clawdi-committed-snapshot-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "var/lib/clawdi");
	process.env.CLAWDI_RUN_DIR = join(root, "run/clawdi");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home/clawdi");
	const paths = getRuntimePaths({ mode: "hosted" });
	ensureRuntimeStateDirs(paths);
	const raw = z
		.record(z.string(), z.unknown())
		.parse(
			JSON.parse(
				readFileSync(
					join(import.meta.dir, "../../../../test-fixtures/runtime-bundle-v2.golden.json"),
					"utf8",
				),
			),
		);
	const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
	raw.manifest = { ...manifest, recovery: { cacheManifest: true, allowOfflineBoot } };
	const parsed = parseHostedRuntimeBundleV2(raw, "test://committed-snapshot");
	const context: RuntimeApplyContext = {
		kind: "context-file",
		backend: "incus",
		identity: {
			generation: resolveRuntimeApplyGeneration(parsed.manifest),
			manifestETag: '"snapshot"',
			applyReceiptId: "snapshot-apply-receipt-0001",
			bootNonce: "snapshot-boot-nonce-000001",
		},
		manifestSource: {
			type: "http",
			url: "https://runtime.test/v1/runtime/manifest",
			auth: { type: "bearer", token: "test-token" },
		},
	};
	const load = applyRuntimeBundleChannelsToManifestLoad(
		{ ...parsed, applyContext: context },
		paths,
	);
	if (!load.sourceRevision) throw new Error("fixture has no source revision");
	const legacy = legacyRuntimeManifestPaths(paths);
	cacheRuntimeLastGoodManifest(load.sourceBundle, legacy, load.secretValues, load.manifest);
	writeRuntimeAppliedState(
		{
			schemaVersion: "clawdi.runtimeAppliedState.v2",
			appliedAt: new Date().toISOString(),
			instanceId: load.manifest.instanceId,
			generation: load.manifest.generation,
			applyGeneration: resolveRuntimeApplyGeneration(load.manifest),
			manifestETag: context.identity.manifestETag,
			applyReceiptId: context.identity.applyReceiptId,
			bootNonce: context.identity.bootNonce,
			etag: `"sha256:${load.sourceRevision}"`,
			sourceRevision: load.sourceRevision,
			contentIdentity: runtimeAppliedContentIdentity(load),
			activated: {},
			providerIds: [],
			projectedProviderIds: {},
		},
		paths,
	);
	return { root, paths, legacy, load, context };
}

function copyPair(from: RuntimePaths, to: RuntimePaths) {
	mkdirSync(dirname(to.manifestLastGood), { recursive: true, mode: 0o700 });
	cpSync(from.manifestLastGood, to.manifestLastGood);
	cpSync(from.managedSecretCacheFile, to.managedSecretCacheFile);
}

test.each(["absent", "stale", "corrupt", "mixed"])(
	"migrates only exact legacy content with a %s durable candidate, then survives cache loss",
	async (candidate) => {
		const { paths, legacy, context, load } = fixture();
		const authority = readFileSync(paths.appliedState, "utf8");
		if (candidate !== "absent") {
			copyPair(legacy, paths);
			if (candidate === "stale") {
				const raw = JSON.parse(readFileSync(paths.manifestLastGood, "utf8"));
				raw.manifest.generation -= 1;
				writeFileSync(paths.manifestLastGood, JSON.stringify(raw));
			} else if (candidate === "corrupt") writeFileSync(paths.manifestLastGood, "not json");
			else writeFileSync(paths.managedSecretCacheFile, "{}");
		}
		const nextContext = {
			...context,
			identity: { ...context.identity, generation: context.identity.generation + 1 },
		};
		expect(migrateCommittedRuntimeSnapshot(paths, nextContext)).toBe(true);
		const committed = loadCommittedRuntimeManifest(paths, nextContext);
		expect("manifest" in committed).toBe(true);
		if (!("manifest" in committed)) throw new Error("expected committed snapshot");
		expect(committed.sourcePath).toBe(paths.manifestLastGood);
		expect(committed.manifest.projection?.channels).toEqual(load.manifest.projection?.channels);
		expect(readFileSync(paths.appliedState, "utf8")).toBe(authority);
		expect(readFileSync(paths.manifestLastGood, "utf8")).toBe(
			readFileSync(legacy.manifestLastGood, "utf8"),
		);
		expect(readFileSync(paths.managedSecretCacheFile, "utf8")).toBe(
			readFileSync(legacy.managedSecretCacheFile, "utf8"),
		);
		for (const [path, mode] of [
			[dirname(paths.manifestLastGood), 0o700],
			[paths.manifestLastGood, 0o600],
			[paths.managedSecretCacheFile, 0o600],
		] as const) {
			const stat = statSync(path);
			expect(stat.mode & 0o777).toBe(mode);
			if (process.getuid) expect(stat.uid).toBe(process.getuid());
			if (process.getgid) expect(stat.gid).toBe(process.getgid());
		}
		rmSync(paths.cacheRoot, { recursive: true, force: true });
		expect("manifest" in loadCommittedRuntimeManifest(paths, nextContext)).toBe(true);
		globalThis.fetch = Object.assign(
			async () => {
				throw new Error("offline");
			},
			{ preconnect: () => undefined },
		);
		const offline = await loadRuntimeManifest(paths, { applyContext: context });
		expect("errors" in offline && offline.errors.join(" ")).toContain(
			"does not allow offline boot",
		);
	},
);

test.each([
	"manifest",
	"secrets",
	"missing-secrets",
	"mixed",
	"instance",
	"generation",
	"apply-generation",
	"authority",
	"permissions",
	"symlink",
])("rejects legacy %s failure without inventing committed authority", (fault) => {
	const { root, paths, legacy, context } = fixture();
	const sensitive = "do-not-expose-secret-bytes";
	if (fault === "manifest") writeFileSync(legacy.manifestLastGood, sensitive);
	else if (fault === "secrets") writeFileSync(legacy.managedSecretCacheFile, sensitive);
	else if (fault === "missing-secrets") rmSync(legacy.managedSecretCacheFile);
	else if (fault === "mixed") writeFileSync(legacy.managedSecretCacheFile, "{}");
	else if (fault === "authority") rmSync(paths.appliedState);
	else if (fault === "permissions") chmodSync(legacy.managedSecretCacheFile, 0o644);
	else if (fault === "symlink") {
		const target = join(root, "linked-secrets.json");
		cpSync(legacy.managedSecretCacheFile, target);
		rmSync(legacy.managedSecretCacheFile);
		symlinkSync(target, legacy.managedSecretCacheFile);
	} else {
		const raw = JSON.parse(readFileSync(legacy.manifestLastGood, "utf8"));
		if (fault === "instance") raw.manifest.instanceId = "different-instance";
		else if (fault === "generation") raw.manifest.generation += 1;
		else raw.applyGeneration = 999;
		writeFileSync(legacy.manifestLastGood, JSON.stringify(raw));
	}
	const rejected = loadCommittedRuntimeManifest(paths, context);
	expect("errors" in rejected).toBe(true);
	expect(JSON.stringify(rejected)).not.toContain(sensitive);
	expect(existsSync(paths.manifestLastGood)).toBe(false);
	expect(existsSync(paths.managedSecretCacheFile)).toBe(false);
});

test("prefers exact durable authority and removes both locations when caching is disabled", () => {
	const { paths, legacy, context, load } = fixture();
	migrateCommittedRuntimeSnapshot(paths, context);
	expect("manifest" in loadCommittedRuntimeManifest(paths, context)).toBe(true);
	writeFileSync(legacy.managedSecretCacheFile, "stale-secret-bytes");
	expect("manifest" in loadCommittedRuntimeManifest(paths, context)).toBe(true);
	const disabled = {
		...load.manifest,
		recovery: { ...load.manifest.recovery, cacheManifest: false },
	};
	cacheRuntimeLastGoodManifest(load.sourceBundle, paths, load.secretValues, disabled);
	for (const candidate of [paths, legacy]) {
		expect(existsSync(candidate.manifestLastGood)).toBe(false);
		expect(existsSync(candidate.managedSecretCacheFile)).toBe(false);
	}
	expect(readRuntimeAppliedState(paths)).not.toBeNull();
	expect("errors" in loadCommittedRuntimeManifest(paths, context)).toBe(true);
});

test("offline boot after replacement still requires the exact boot/apply identity", async () => {
	const { paths, context } = fixture(true);
	migrateCommittedRuntimeSnapshot(paths, context);
	globalThis.fetch = Object.assign(
		async () => {
			throw new Error("offline");
		},
		{ preconnect: () => undefined },
	);
	expect("manifest" in (await loadRuntimeManifest(paths, { applyContext: context }))).toBe(true);
	rmSync(paths.cacheRoot, { recursive: true, force: true });
	expect("manifest" in (await loadRuntimeManifest(paths, { applyContext: context }))).toBe(true);
	const nextContext = {
		...context,
		identity: { ...context.identity, bootNonce: "different-boot-nonce-000001" },
	};
	const rejected = await loadRuntimeManifest(paths, { applyContext: nextContext });
	expect("errors" in rejected && rejected.errors.join(" ")).toContain(
		"does not match the current runtime apply identity",
	);
	expect("manifest" in loadCommittedRuntimeManifest(paths, nextContext)).toBe(true);
});

test("readers stay pure and staged content cannot replace the previous applied authority", () => {
	const { paths, legacy, context, load } = fixture();
	expect("manifest" in loadCommittedRuntimeManifest(paths, context)).toBe(true);
	expect(existsSync(paths.manifestLastGood)).toBe(false);
	const before = readRuntimeAppliedState(paths);
	if (!before) throw new Error("missing fixture authority");
	const next = z.record(z.string(), z.unknown()).parse(structuredClone(load.sourceBundle));
	const manifest = z.record(z.string(), z.unknown()).parse(next.manifest);
	next.manifest = { ...manifest, generation: load.manifest.generation + 1 };
	cacheRuntimeLastGoodManifest(next, paths, load.secretValues, load.manifest);
	rmSync(paths.cacheRoot, { recursive: true, force: true });
	// Simulate termination after staging/mirror replacement, before applied-state commit.
	const restored = loadCommittedRuntimeManifest(paths, context);
	expect("manifest" in restored && restored.sourceBundle).toEqual(load.sourceBundle);
	const snapshot = runtimeSnapshotPath(paths, before.contentIdentity.sha256);
	expect(statSync(snapshot).mode & 0o777).toBe(0o600);
	// A damaged mirror cannot affect the exact one-file snapshot.
	writeFileSync(paths.managedSecretCacheFile, "{}");
	expect("manifest" in loadCommittedRuntimeManifest(paths, context)).toBe(true);
	expect(existsSync(legacy.manifestLastGood)).toBe(false);
});

test("migration persistence failure is explicit and leaves legacy authority readable", () => {
	const { paths, context } = fixture();
	// A non-directory at the destination fails even in the root isolated runner.
	writeFileSync(dirname(paths.manifestLastGood), "blocked", { mode: 0o600 });
	expect(() => migrateCommittedRuntimeSnapshot(paths, context)).toThrow(
		"could not persist verified committed runtime snapshot",
	);
	expect("manifest" in loadCommittedRuntimeManifest(paths, context)).toBe(true);
});

test("cache-disabled commit validates authority before deleting recoverable history", () => {
	const { paths, context, load } = fixture();
	migrateCommittedRuntimeSnapshot(paths, context);
	const disabled = {
		...load,
		manifest: { ...load.manifest, recovery: { ...load.manifest.recovery, cacheManifest: false } },
	};
	const convergence = runtimeConvergenceWithoutApply({
		load: disabled,
		paths,
		workspaceRoot: paths.workspaceRoot,
		enabledRuntimes: [],
		installErrors: [],
		projectedProviderIds: {},
	});
	const input = {
		load: disabled,
		paths,
		convergence,
		etag: "",
		sourceRevision: "invalid",
		applyIdentity: context.identity,
	};
	expect(() => commitRuntimeAppliedState(input)).toThrow();
	expect("manifest" in loadCommittedRuntimeManifest(paths, context)).toBe(true);
});

test.each(["content", "permissions", "symlink"])(
	"rejects an atomic snapshot with %s damage after pair/cache loss",
	(fault) => {
		const { root, paths, context } = fixture();
		migrateCommittedRuntimeSnapshot(paths, context);
		const applied = readRuntimeAppliedState(paths);
		if (!applied) throw new Error("missing fixture authority");
		const snapshot = runtimeSnapshotPath(paths, applied.contentIdentity.sha256);
		rmSync(paths.cacheRoot, { recursive: true, force: true });
		rmSync(paths.manifestLastGood);
		rmSync(paths.managedSecretCacheFile);
		if (fault === "content") writeFileSync(snapshot, '{"secretValues":"never-expose-this-value"}');
		else if (fault === "permissions") chmodSync(snapshot, 0o644);
		else {
			const target = join(root, "snapshot-target.json");
			cpSync(snapshot, target);
			rmSync(snapshot);
			symlinkSync(target, snapshot);
		}
		const rejected = loadCommittedRuntimeManifest(paths, context);
		expect("errors" in rejected).toBe(true);
		expect(JSON.stringify(rejected)).not.toContain("never-expose-this-value");
		expect(existsSync(paths.manifestLastGood)).toBe(false);
	},
);
