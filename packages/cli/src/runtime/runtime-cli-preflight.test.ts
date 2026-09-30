import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { RuntimeApplyContext } from "./apply-identity";
import type { RuntimeCliUpdateResult } from "./cli-update";
import {
	HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
	loadRemoteRuntimeManifest,
	loadRuntimeManifest,
} from "./manifest-source";
import { getRuntimePaths } from "./paths";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const roots: string[] = [];
const golden = z
	.record(z.string(), z.unknown())
	.parse(
		JSON.parse(
			readFileSync(
				resolve(import.meta.dir, "../../../../test-fixtures/runtime-bundle-v2.golden.json"),
				"utf8",
			),
		),
	);
const manifest = z.record(z.string(), z.unknown()).parse(golden.manifest);
const revision = z.string().parse(golden.sourceRevision);

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(body: unknown, etag = `"sha256:${revision}"`) {
	const root = mkdtempSync(join(tmpdir(), "clawdi-cli-preflight-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = "/home/clawdi";
	const paths = getRuntimePaths({ mode: "hosted" });
	const applyContext: RuntimeApplyContext = {
		kind: "context-file",
		backend: "incus",
		identity: {
			generation: 1,
			manifestETag: '"manifest-1"',
			applyReceiptId: "apply-receipt-0001",
			bootNonce: "boot-nonce-000001",
		},
		manifestSource: {
			type: "http",
			url: "https://runtime.test/v1/runtime/manifest",
			auth: { type: "bearer", token: "test-token" },
		},
	};
	globalThis.fetch = Object.assign(
		async () =>
			new Response(JSON.stringify(body), {
				headers: { "content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE, etag },
			}),
		{ preconnect: () => undefined },
	);
	const result: RuntimeCliUpdateResult = {
		status: "installed",
		packageSpec: "clawdi@1.2.3-test",
		registry: "https://registry.npmjs.org",
		npmPrefix: paths.cliNpmPrefix,
		npmCache: paths.cliNpmCache,
		activePath: paths.cliManagedBin,
		activeTarget: join(root, "new-cli"),
		version: "1.2.3-test",
		retryAt: null,
		selfReexec: true,
	};
	return { paths, applyContext, result };
}

test("hands over to the requested CLI before parsing fields unknown to the running version", async () => {
	const body = { ...golden, manifest: { ...manifest, futureRuntimePolicy: { enabled: true } } };
	const { paths, applyContext, result } = setup(body);
	let calls = 0;
	const loaded = await loadRuntimeManifest(paths, {
		applyContext,
		prepareCli: (policy) => {
			calls++;
			expect(policy.clawdiCli?.packageSpec).toBe("clawdi@1.2.3-test");
			return result;
		},
	});
	expect(calls).toBe(1);
	expect(loaded).toMatchObject({ cliPreparation: { selfReexec: true }, generation: 2 });
	expect("manifest" in loaded).toBe(false);
});

test("does not weaken runtime validation after the matching CLI takes over", async () => {
	const { paths, applyContext, result } = setup({
		...golden,
		manifest: { ...manifest, futureRuntimePolicy: true },
	});
	const loaded = await loadRemoteRuntimeManifest(paths, {
		applyContext,
		prepareCli: () => ({ ...result, status: "current", selfReexec: false }),
	});
	expect(loaded).toMatchObject({ mode: "manifest-rejected" });
});

test.each([
	["wrong validator", golden, `"sha256:${"f".repeat(64)}"`],
	["wrong apply generation", { ...golden, applyGeneration: 9 }, `"sha256:${revision}"`],
	[
		"untrusted package registry",
		{
			...golden,
			manifest: {
				...manifest,
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@1.2.3",
					registry: "https://untrusted.test",
				},
			},
		},
		`"sha256:${revision}"`,
	],
])("rejects %s before installing a CLI", async (_name, body, etag) => {
	const { paths, applyContext, result } = setup(body, etag);
	let calls = 0;
	const loaded = await loadRemoteRuntimeManifest(paths, {
		applyContext,
		prepareCli: () => {
			calls++;
			return result;
		},
	});
	expect(calls).toBe(0);
	expect(loaded).toMatchObject({ mode: "manifest-rejected" });
});

test("keeps failed CLI installation separate from runtime application", async () => {
	const { paths, applyContext, result } = setup(golden);
	const loaded = await loadRemoteRuntimeManifest(paths, {
		applyContext,
		prepareCli: () => ({
			...result,
			status: "error",
			selfReexec: false,
			error: "verification failed",
		}),
	});
	expect(loaded).toMatchObject({ cliPreparation: { status: "error", selfReexec: false } });
	expect("manifest" in loaded).toBe(false);
});
