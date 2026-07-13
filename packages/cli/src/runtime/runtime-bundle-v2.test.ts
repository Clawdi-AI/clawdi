import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyRuntimeBundleChannelsToManifestLoad } from "./channels";
import { cacheRuntimeLastGoodManifest } from "./manifest";
import {
	HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
	loadRemoteRuntimeManifest,
	normalizeHostedRuntimeBundleV2,
} from "./manifest-source";
import { getRuntimePaths } from "./paths";

const goldenPath = resolve(
	import.meta.dir,
	"../../../../test-fixtures/runtime-bundle-v2.golden.json",
);
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const roots: string[] = [];

afterEach(() => {
	process.env = { ...originalEnv };
	globalThis.fetch = originalFetch;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hosted runtime bundle v2", () => {
	test("strictly parses the shared golden and projects channels in TypeScript", () => {
		const raw = JSON.parse(readFileSync(goldenPath, "utf-8")) as unknown;
		const load = normalizeHostedRuntimeBundleV2(raw);
		const projected = applyRuntimeBundleChannelsToManifestLoad(load);

		expect(projected.sourceRevision).toBe(
			"f1187e61d8a4111aac6e82d69ba356e76224a1e1908c4e455b1bd98dc2b63fbd",
		);
		expect(projected.secretValues).toMatchObject(
			(raw as { secretValues: Record<string, string> }).secretValues,
		);
		expect(projected.manifest.projection?.channels).toMatchObject({
			telegram: {
				accounts: {
					clawdi_500000000000: {
						enabled: true,
						botToken: {
							source: "env",
							provider: "default",
							id: "CLAWDI_CHANNEL_TELEGRAM_CLAWDI_500000000000_AGENT_TOKEN",
						},
					},
				},
			},
		});
	});

	test("rejects unknown fields and dormant providers", () => {
		const raw = JSON.parse(readFileSync(goldenPath, "utf-8")) as Record<string, unknown>;
		expect(() =>
			normalizeHostedRuntimeBundleV2({ ...raw, rendererIdentity: "forbidden" }),
		).toThrow();
		const binding = (raw.channelBindings as Record<string, unknown>[])[0];
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				channelBindings: [{ ...binding, provider: "whatsapp" }],
			}),
		).toThrow();
	});

	test("negotiates the exact media type and uses one conditional validator", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_RUNTIME_AUTH_ENV = "CLAWDI_TEST_TOKEN";
		process.env.CLAWDI_TEST_TOKEN = "clawdi_test";
		const paths = getRuntimePaths({ mode: "hosted" });
		let requests = 0;
		globalThis.fetch = Object.assign(
			async (_input: URL | RequestInfo, init?: RequestInit) => {
				requests += 1;
				const headers = new Headers(init?.headers);
				expect(headers.get("accept")).toBe(HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE);
				expect(headers.get("if-none-match")).toBe('"bundle-1"');
				return new Response(null, { status: 304, headers: { etag: '"bundle-1"' } });
			},
			{ preconnect: () => undefined },
		);

		const loaded = await loadRemoteRuntimeManifest(paths, { ifNoneMatch: '"bundle-1"' });
		expect(requests).toBe(1);
		expect(loaded).toMatchObject({ notModified: true, etag: '"bundle-1"' });
	});

	test("fails closed when the server returns legacy application/json", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-legacy-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_RUNTIME_AUTH_ENV = "CLAWDI_TEST_TOKEN";
		process.env.CLAWDI_TEST_TOKEN = "clawdi_test";
		const paths = getRuntimePaths({ mode: "hosted" });
		globalThis.fetch = Object.assign(
			async () =>
				new Response(readFileSync(goldenPath, "utf-8"), {
					status: 200,
					headers: { "content-type": "application/json", etag: '"legacy"' },
				}),
			{ preconnect: () => undefined },
		);

		const loaded = await loadRemoteRuntimeManifest(paths);
		expect(loaded).toMatchObject({ mode: "repair", stage: "network" });
		expect("errors" in loaded ? loaded.errors[0] : "").toContain(
			`content-type must be ${HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE}`,
		);
	});

	test("preserves bundle authority and bindings through remote validation", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-load-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = "/home/clawdi";
		process.env.CLAWDI_RUNTIME_MANIFEST_URL = "https://runtime.test/v1/runtime/manifest";
		process.env.CLAWDI_RUNTIME_AUTH_ENV = "CLAWDI_TEST_TOKEN";
		process.env.CLAWDI_TEST_TOKEN = "clawdi_test";
		const paths = getRuntimePaths({ mode: "hosted" });
		globalThis.fetch = Object.assign(
			async () =>
				new Response(readFileSync(goldenPath, "utf-8"), {
					status: 200,
					headers: {
						"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
						etag: '"bundle-golden"',
					},
				}),
			{ preconnect: () => undefined },
		);

		const loaded = await loadRemoteRuntimeManifest(paths);
		if (!("manifest" in loaded)) throw new Error(JSON.stringify(loaded));
		expect(loaded.etag).toBe('"bundle-golden"');
		expect(loaded.sourceRevision).toBe(
			"f1187e61d8a4111aac6e82d69ba356e76224a1e1908c4e455b1bd98dc2b63fbd",
		);
		expect(loaded.channelBindings).toHaveLength(1);
	});

	test("caches the effective projected manifest and only the scoped secret map", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-cache-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const paths = getRuntimePaths({ mode: "hosted" });
		const raw = JSON.parse(readFileSync(goldenPath, "utf-8")) as unknown;
		const projected = applyRuntimeBundleChannelsToManifestLoad(normalizeHostedRuntimeBundleV2(raw));

		cacheRuntimeLastGoodManifest(projected.manifest, paths, projected.secretValues);
		const manifestCache = readFileSync(paths.manifestLastGood, "utf-8");
		const secretCache = readFileSync(paths.managedSecretCacheFile, "utf-8");
		expect(manifestCache).toContain("CLAWDI_CHANNEL_TELEGRAM_CLAWDI_500000000000_AGENT_TOKEN");
		expect(manifestCache).not.toContain("telegram-agent-golden");
		expect(secretCache).toContain("999999999:eea06335e768d7a82e535465ae3b8bbd");
		expect(secretCache).not.toContain("telegram-agent-golden");
		expect(secretCache).not.toContain("channelBindings");
		expect(secretCache).not.toContain("sourceRevision");
	});

	test("treats secret rotation at unchanged generation as a new applied identity", () => {
		const raw = JSON.parse(readFileSync(goldenPath, "utf-8")) as {
			generation?: number;
			manifest: { generation: number };
			secretValues: Record<string, string>;
			sourceRevision: string;
		};
		const rotated = {
			...raw,
			sourceRevision: "e".repeat(64),
			secretValues: {
				...raw.secretValues,
				"secret://channels/telegram/clawdi_500000000000/agent-token":
					"123456789:telegram-agent-rotated",
			},
		};
		const before = applyRuntimeBundleChannelsToManifestLoad(normalizeHostedRuntimeBundleV2(raw));
		const after = applyRuntimeBundleChannelsToManifestLoad(normalizeHostedRuntimeBundleV2(rotated));

		expect(after.manifest.generation).toBe(before.manifest.generation);
		expect(after.sourceRevision).not.toBe(before.sourceRevision);
		expect(after.secretValues).not.toEqual(before.secretValues);
		expect(after.manifest).toEqual(before.manifest);
	});
});
