import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { applyRuntimeBundleChannelsToManifestLoad } from "./channels";
import { cacheRuntimeLastGoodManifest, convergeRuntimeManifest } from "./manifest";
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
	test("accepts the hosted-emitted gateway secret contract before projecting channels", () => {
		const raw = JSON.parse(readFileSync(goldenPath, "utf-8")) as unknown;
		const load = normalizeHostedRuntimeBundleV2(raw);
		expect(load.manifest.runtimes.openclaw.run?.secretEnv).toMatchObject({
			OPENCLAW_GATEWAY_TOKEN: "env://OPENCLAW_GATEWAY_TOKEN",
		});
		const projected = applyRuntimeBundleChannelsToManifestLoad(load);

		expect(projected.sourceRevision).toBe(
			"6a65e1da8ba5c467a1a6d65d1959431b72de7e596e5dbed0caada491e4dad5cd",
		);
		expect(projected.manifest.runtimes.openclaw.run?.secretEnv).toMatchObject({
			OPENCLAW_GATEWAY_TOKEN: "env://OPENCLAW_GATEWAY_TOKEN",
		});
		expect(projected.secretValues).toMatchObject(
			(raw as { secretValues: Record<string, string> }).secretValues,
		);
		expect(projected.manifest.projection?.channels).toMatchObject({
			telegram: {
				accounts: {
					clawdi_50000000000000000000000000000005: {
						enabled: true,
						botToken: {
							source: "env",
							provider: "default",
							id: "CLAWDI_CHANNEL_TELEGRAM_CLAWDI_50000000000000000000000000000005_AGENT_TOKEN",
						},
					},
				},
			},
		});
	});

	test("keeps live-sync channel bindings applicable from the runtime watch service", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-watch-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_HOME = join(root, "clawdi-home");
		process.env.HOME = process.env.CLAWDI_RUNTIME_HOME;
		process.env.CLAWDI_AUTH_TOKEN = "test-token";
		process.env.CLAWDI_RUNTIME_AUTH_ENV = "CLAWDI_AUTH_TOKEN";
		process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		process.env.CLAWDI_RUNTIME_INSTALL_OFFICIAL_SERVICES = "0";
		process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
		const paths = getRuntimePaths({ mode: "hosted" });
		const openclawBin = join(paths.userHome, ".openclaw", "bin", "openclaw");
		const channelPatchPath = join(root, "openclaw-channel-patch.json");
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(
			openclawBin,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				'if [[ "$1 $2 $3" == "config patch --stdin" ]]; then',
				"  payload=$(cat)",
				`  if [[ "$payload" == *'"channels"'* && "$payload" == *'"telegram"'* ]]; then`,
				`    printf '%s\\n' "$payload" > '${channelPatchPath}'`,
				"  fi",
				"fi",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);

		const raw = JSON.parse(readFileSync(goldenPath, "utf-8")) as unknown;
		const projected = applyRuntimeBundleChannelsToManifestLoad(normalizeHostedRuntimeBundleV2(raw));
		const openclaw = structuredClone(projected.manifest.runtimes.openclaw);
		openclaw.providerMode = "unmanaged";
		openclaw.provider_ids = [];
		delete openclaw.primary_model;
		const projection = structuredClone(projected.manifest.projection);
		if (!projection) throw new Error("runtime bundle projection is unavailable");
		delete projection.providers;
		delete projection.terminalTooling;
		const load = {
			...projected,
			manifest: {
				...projected.manifest,
				runtimes: { openclaw },
				projection,
			},
		};
		const result = convergeRuntimeManifest(load, paths, {
			managedGatewayModelListFetcher: ({ baseUrl }) => ({
				status: "ok",
				endpoint: `${baseUrl}/models`,
				models: [{ id: "gpt-test" }],
			}),
		});

		expect(result.installErrors).toEqual([]);
		const watchUnit = readFileSync(
			join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
			"utf-8",
		);
		const watchEnvPath = join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env");
		expect(watchUnit).toContain(`EnvironmentFile=${watchEnvPath}`);
		const gatewayTokenLine = 'OPENCLAW_GATEWAY_TOKEN="gateway-token"';
		expect(readFileSync(watchEnvPath, "utf-8")).toContain(gatewayTokenLine);
		expect(
			readFileSync(join(paths.systemdEnvRoot, "openclaw-gateway.service.env"), "utf-8"),
		).toContain(gatewayTokenLine);
		expect(JSON.parse(readFileSync(channelPatchPath, "utf-8"))).toMatchObject({
			channels: {
				telegram: {
					accounts: {
						clawdi_50000000000000000000000000000005: {
							enabled: true,
							botToken: {
								source: "env",
								provider: "default",
								id: "CLAWDI_CHANNEL_TELEGRAM_CLAWDI_50000000000000000000000000000005_AGENT_TOKEN",
							},
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

	test("rejects response-carried apply identity and keeps the inner manifest v1-only", () => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		expect(normalizeHostedRuntimeBundleV2(raw).manifest.projection?.sourceSchemaVersion).toBe(
			"clawdi.hosted-runtime.manifest.v1",
		);
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					schemaVersion: "clawdi.hosted-runtime.manifest.v2",
					manifestETag: '"manifest-7"',
					applyReceiptId: "apply-receipt-0007",
					bootNonce: "boot-nonce-000007",
				},
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
		process.env.CLAWDI_RUNTIME_GENERATION = "7";
		process.env.CLAWDI_RUNTIME_MANIFEST_ETAG = '"manifest-7"';
		process.env.CLAWDI_RUNTIME_APPLY_RECEIPT_ID = "apply-receipt-0007";
		process.env.CLAWDI_RUNTIME_BOOT_NONCE = "boot-nonce-000007";
		const paths = getRuntimePaths({ mode: "hosted" });
		let requests = 0;
		globalThis.fetch = Object.assign(
			async (_input: URL | RequestInfo, init?: RequestInit) => {
				requests += 1;
				const headers = new Headers(init?.headers);
				expect(headers.get("accept")).toBe(HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE);
				expect(headers.get("if-none-match")).toBe('"bundle-1"');
				expect(headers.get("x-clawdi-runtime-generation")).toBeNull();
				expect(headers.get("x-clawdi-runtime-manifest-etag")).toBeNull();
				expect(headers.get("x-clawdi-runtime-apply-receipt-id")).toBeNull();
				expect(headers.get("x-clawdi-runtime-boot-nonce")).toBeNull();
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
			"6a65e1da8ba5c467a1a6d65d1959431b72de7e596e5dbed0caada491e4dad5cd",
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
		expect(manifestCache).toContain(
			"CLAWDI_CHANNEL_TELEGRAM_CLAWDI_50000000000000000000000000000005_AGENT_TOKEN",
		);
		expect(manifestCache).not.toContain("telegram-agent-golden");
		expect(secretCache).toContain("999999999:9ded1453047ec0a48ec3b735075f7448");
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
				"secret://channels/telegram/clawdi_50000000000000000000000000000005/agent-token":
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
