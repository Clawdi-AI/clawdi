import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { commitRuntimeAppliedState, runtimeAppliedContentIdentity } from "../commands/runtime";
import { readRuntimeAppliedState, runtimeContentSha256 } from "./applied-state";
import {
	type RuntimeApplyContext,
	readRuntimeApplyContext,
	resolveRuntimeApplyGeneration,
} from "./apply-identity";
import { applyRuntimeBundleChannelsToManifestLoad as applyRuntimeBundleChannelsToManifestLoadWithContext } from "./channels";
import {
	hostedManifestEgressProfiles,
	managedMcpHeaderPlaceholder,
} from "./hosted-egress-profiles";
import {
	cacheRuntimeLastGoodManifest,
	convergeRuntimeManifest as convergeRuntimeManifestWithContract,
} from "./manifest";
import {
	HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
	loadRemoteRuntimeManifest,
	loadRuntimeManifest,
	normalizeHostedRuntimeBundleV2,
	type RuntimeManifestLoad,
} from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { ensureRuntimeStateDirs } from "./state";

const goldenPath = resolve(
	import.meta.dir,
	"../../../../test-fixtures/runtime-bundle-v2.golden.json",
);
const EXPECTED_GOLDEN_SOURCE_REVISION =
	"3a4e4ca33ff1d12064659954d3607ad74af25ca87360ab27de28091bba6bad3e";
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const roots: string[] = [];
const TEST_PROCESS_UID = process.getuid?.() ?? 1_000;
const TEST_PROCESS_GID = process.getgid?.() ?? 1_000;
const TEST_RUNTIME_USER = String(TEST_PROCESS_UID);

function convergeRuntimeManifest(
	load: RuntimeManifestLoad,
	paths: RuntimePaths,
	opts: Parameters<typeof convergeRuntimeManifestWithContract>[2] = {},
) {
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_RUNTIME_USER = TEST_RUNTIME_USER;
	ensureRuntimeStateDirs(paths);
	return convergeRuntimeManifestWithContract(load, paths, {
		...opts,
		hostedRuntimeContract: opts.hostedRuntimeContract ?? {
			expectedIdentity: {
				home: paths.userHome,
				user: TEST_RUNTIME_USER,
				uid: TEST_PROCESS_UID,
				gid: TEST_PROCESS_GID,
			},
			resolveUserIdentity: () => ({ uid: TEST_PROCESS_UID, gid: TEST_PROCESS_GID }),
		},
	});
}

function applyRuntimeBundleChannelsToManifestLoad(load: RuntimeManifestLoad): RuntimeManifestLoad {
	const authToken = process.env.CLAWDI_BOOTSTRAP_AUTH_TOKEN ?? "test-token";
	return applyRuntimeBundleChannelsToManifestLoadWithContext({
		...load,
		applyContext: {
			kind: "context-file",
			backend: "incus",
			identity: {
				generation: load.manifest.applyGeneration ?? load.manifest.generation,
				manifestETag: `"test-${load.manifest.generation}"`,
				applyReceiptId: "test-apply-receipt",
				bootNonce: "test-boot-nonce",
			},
			cliPackageSpec: "clawdi@1.2.3",
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env-test",
				auth: { type: "bearer", token: authToken },
			},
		},
	});
}

function readFileTree(root: string): string {
	if (!existsSync(root)) return "";
	const stat = lstatSync(root);
	if (stat.isSymbolicLink()) return "";
	if (stat.isFile()) return readFileSync(root, "utf-8");
	if (!stat.isDirectory()) return "";
	return readdirSync(root)
		.sort()
		.map((entry) => readFileTree(join(root, entry)))
		.join("\n");
}

function setRuntimeApplyIdentityFile(
	root: string,
	identity: { generation: number; manifestETag: string; applyReceiptId: string; bootNonce: string },
	cliPackageSpec = "clawdi@1.2.3",
): RuntimeApplyContext {
	const path = join(root, "runtime-context.json");
	writeFileSync(
		path,
		JSON.stringify({
			schemaVersion: "clawdi.runtimeContext.v2",
			backend: "incus",
			apply: identity,
			cliPackageSpec,
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env-test",
				auth: {
					type: "bearer",
					token: "clawdi_test",
				},
			},
		}),
	);
	return readRuntimeApplyContext(path);
}

function validateGeneratedEgressConfig(addonPath: string, envFilePath: string): void {
	execFileSync(
		"python3",
		[
			"-c",
			[
				"import importlib.util",
				"import sys",
				"spec = importlib.util.spec_from_file_location('clawdi_egress_addon_test', sys.argv[1])",
				"module = importlib.util.module_from_spec(spec)",
				"spec.loader.exec_module(module)",
				"addon = module.ClawdiEgressAddon()",
				"addon.reload_from_environment({'CLAWDI_EGRESS_ENV_FILE': sys.argv[2]})",
			].join("\n"),
			addonPath,
			envFilePath,
		],
		{ stdio: "pipe" },
	);
}

afterEach(() => {
	process.env = { ...originalEnv };
	globalThis.fetch = originalFetch;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hosted runtime bundle v2", () => {
	test("reads an old bundle by falling back from omitted apply generation to checkpoint", () => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		delete raw.applyGeneration;
		const load = normalizeHostedRuntimeBundleV2(raw);

		expect(load.manifest.generation).toBe(2);
		expect(load.manifest.applyGeneration).toBeUndefined();
		expect(resolveRuntimeApplyGeneration(load.manifest)).toBe(2);
	});

	test("accepts the hosted-emitted gateway secret contract before projecting channels", () => {
		const raw = JSON.parse(readFileSync(goldenPath, "utf-8")) as unknown;
		const load = normalizeHostedRuntimeBundleV2(raw);
		expect(load.manifest.runtimes.openclaw.run?.secretEnv).toMatchObject({
			OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
		});
		const projected = applyRuntimeBundleChannelsToManifestLoad(load);

		expect(projected.sourceRevision).toBe(EXPECTED_GOLDEN_SOURCE_REVISION);
		expect(projected.manifest.runtimes.openclaw.run?.secretEnv).toMatchObject({
			OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
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

	test("accepts generic hosted MCP and skill resource intent with a future CLI fixture", () => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		const load = normalizeHostedRuntimeBundleV2({
			...raw,
			manifest: {
				...manifest,
				clawdiCli: {
					source: "npm:clawdi",
					packageSpec: "clawdi@1.2.5-test",
					registry: "https://registry.npmjs.org",
				},
				mcp: {
					servers: {
						clawdi: {
							url: "https://cloud-api.test/v1/mcp/clawdi",
							transport: "streamable-http",
							headers: {
								Authorization: {
									secretRef: "secret://clawdi/auth-token",
									prefix: "Bearer ",
								},
							},
						},
						"search-proxy": { command: "searchctl", args: ["serve"] },
					},
				},
				skills: { entries: { clawdi: { enabled: true, version: 1 } } },
			},
		});
		expect(load.manifest.projection?.mcp).toEqual({
			servers: {
				clawdi: {
					url: "https://cloud-api.test/v1/mcp/clawdi",
					transport: "streamable-http",
					headers: {
						Authorization: {
							secretRef: "secret://clawdi/auth-token",
							prefix: "Bearer ",
						},
					},
				},
				"search-proxy": { command: "searchctl", args: ["serve"] },
			},
		});
		expect(load.manifest.projection?.skills).toEqual({
			entries: { clawdi: { enabled: true, version: 1 } },
		});
		expect(load.manifest.egressProfiles?.profiles).toContainEqual(
			expect.objectContaining({
				id: "managed-mcp-clawdi",
				owner: "mcp-projection",
				match: expect.objectContaining({
					scheme: "https",
					host: "cloud-api.test:443",
					path: { type: "equals", value: "/v1/mcp/clawdi" },
					headers: {
						Authorization: {
							type: "equals",
							value: managedMcpHeaderPlaceholder("clawdi", "Authorization"),
							prefix: "Bearer ",
						},
					},
				}),
				rewrite: expect.objectContaining({
					setHeaders: {
						Authorization: {
							type: "secretRef",
							secretRef: "secret://clawdi/auth-token",
							prefix: "Bearer ",
						},
					},
				}),
			}),
		);
	});

	test("normalizes an enabled-only pre-expand Skill entry to the pinned v1 bundle", () => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		const load = normalizeHostedRuntimeBundleV2({
			...raw,
			manifest: {
				...manifest,
				skills: { entries: { clawdi: { enabled: true } } },
			},
		});

		expect(load.manifest.projection?.skills).toEqual({
			entries: { clawdi: { enabled: true, version: 1 } },
		});
	});

	test("retains an exact immutable repository-root Skill source", () => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		const source = {
			type: "github",
			url: "https://github.com/Clawdi-AI/store",
			path: "",
			commit: "a".repeat(40),
		} as const;
		const load = normalizeHostedRuntimeBundleV2({
			...raw,
			manifest: {
				...manifest,
				skills: {
					entries: { "review-pr": { enabled: true, source } },
				},
			},
		});

		expect(load.manifest.projection?.skills).toEqual({
			entries: { "review-pr": { enabled: true, source } },
		});
	});

	test.each([
		["branch commit", { commit: "main" }],
		["uppercase commit", { commit: "A".repeat(40) }],
		["tree URL", { url: `https://github.com/Clawdi-AI/store/tree/${"a".repeat(40)}` }],
		["trailing repository slash", { url: "https://github.com/Clawdi-AI/store/" }],
		["traversal path", { path: "skills/../review-pr" }],
	])("rejects sourced Skill source with %s", (_label, override) => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					skills: {
						entries: {
							"review-pr": {
								enabled: true,
								source: {
									type: "github",
									url: "https://github.com/Clawdi-AI/store",
									path: "skills/review-pr",
									commit: "a".repeat(40),
									...override,
								},
							},
						},
					},
				},
			}),
		).toThrow();
	});

	test.each([
		"latest",
		"1",
		true,
		0,
		-1,
		1.5,
		null,
	])("rejects invalid hosted Skill version %p", (version) => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					skills: { entries: { clawdi: { enabled: true, version } } },
				},
			}),
		).toThrow();
	});

	test.each([
		"variant",
		"path",
		"content",
		"packageSpec",
	])("rejects hosted Skill entry field %s", (field) => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					skills: {
						entries: { clawdi: { enabled: true, version: 1, [field]: "forbidden" } },
					},
				},
			}),
		).toThrow();
	});

	test("uses distinct public placeholders for each remote MCP server and header", () => {
		const profiles = hostedManifestEgressProfiles({
			mcp: {
				servers: {
					alpha: {
						url: "https://cloud-api.test/v1/mcp/shared",
						transport: "streamable-http",
						headers: {
							Authorization: { secretRef: "secret://mcp/alpha-token", prefix: "Bearer " },
							"X-Client-Token": { secretRef: "secret://alpha.client", prefix: "" },
						},
					},
					beta: {
						url: "https://cloud-api.test/v1/mcp/shared",
						transport: "streamable-http",
						headers: {
							Authorization: { secretRef: "secret://mcp/beta-token", prefix: "Bearer " },
						},
					},
				},
			},
		}).profiles.filter((profile) => profile.owner === "mcp-projection");

		expect(profiles).toHaveLength(2);
		const alpha = profiles.find((profile) => profile.id === "managed-mcp-alpha");
		const beta = profiles.find((profile) => profile.id === "managed-mcp-beta");
		expect(alpha?.match.headers.Authorization).toMatchObject({
			value: managedMcpHeaderPlaceholder("alpha", "Authorization"),
		});
		expect(alpha?.match.headers["X-Client-Token"]).toMatchObject({
			value: managedMcpHeaderPlaceholder("alpha", "X-Client-Token"),
		});
		expect(beta?.match.headers.Authorization).toMatchObject({
			value: managedMcpHeaderPlaceholder("beta", "Authorization"),
		});
		expect(
			new Set([
				managedMcpHeaderPlaceholder("alpha", "Authorization"),
				managedMcpHeaderPlaceholder("alpha", "X-Client-Token"),
				managedMcpHeaderPlaceholder("beta", "Authorization"),
			]).size,
		).toBe(3);
	});

	test("resolves canonical auth for fresh boot and watcher reconcile without widening secret scope", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-watch-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_HOME = join(root, "clawdi-home");
		process.env.HOME = process.env.CLAWDI_RUNTIME_HOME;
		process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		const paths = getRuntimePaths({ mode: "hosted" });
		const openclawBin = join(paths.userHome, ".local", "bin", "openclaw");
		const openclawConfigPath = join(paths.userHome, ".openclaw", "openclaw.json");
		const channelPatchPath = join(root, "openclaw-channel-patch.json");
		const mcpSecretRef = "secret://mcp/sidecar-only/token";
		const mcpSecret = "mcp-sidecar-only-secret";
		const egressEngine = {
			type: "mitmproxy",
			version: "12.2.3",
			url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
			sha256: "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
		} as const;
		const mitmdump = join(
			paths.egressEngineMaintainedRoot,
			egressEngine.version,
			egressEngine.sha256,
			"mitmdump",
		);
		mkdirSync(dirname(mitmdump), { recursive: true });
		writeFileSync(mitmdump, "#!/usr/bin/env sh\nexit 0\n");
		chmodSync(mitmdump, 0o755);
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(dirname(openclawConfigPath), { recursive: true });
		writeFileSync(
			openclawBin,
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				'if [[ "$1 $2 $3" == "agents list --json" ]]; then',
				'  printf \'[{"id":"main","workspace":"%s"}]\\n\' "$HOME/.openclaw/workspace"',
				'elif [[ "$1 $2 $3" == "config patch --stdin" ]]; then',
				"  payload=$(cat)",
				`  if [[ "$payload" == *'"channels"'* && "$payload" == *'"telegram"'* ]]; then`,
				`    printf '%s\\n' "$payload" > '${channelPatchPath}'`,
				"  fi",
				'elif [[ "$1 $2" == "mcp set" ]]; then',
				`  python3 - "$3" "$4" '${openclawConfigPath}' <<'PY'`,
				"import json",
				"import sys",
				"name, payload, path = sys.argv[1:]",
				"with open(path, encoding='utf-8') as handle:",
				"    config = json.load(handle)",
				"config.setdefault('mcp', {}).setdefault('servers', {})[name] = json.loads(payload)",
				"with open(path, 'w', encoding='utf-8') as handle:",
				"    json.dump(config, handle)",
				"PY",
				"fi",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);
		writeFileSync(openclawConfigPath, '{"mcp":{"servers":{}}}\n');

		const raw = JSON.parse(readFileSync(goldenPath, "utf-8")) as {
			manifest: Record<string, unknown>;
			secretValues: Record<string, string>;
			sourceRevision: string;
		};
		raw.manifest = {
			...raw.manifest,
			egressEngine,
			mcp: {
				servers: {
					clawdi: {
						url: "https://cloud-api.test/v1/mcp/clawdi",
						transport: "streamable-http",
						headers: {
							Authorization: {
								secretRef: "secret://clawdi/auth-token",
								prefix: "Bearer ",
							},
						},
					},
					"sidecar-only": {
						url: "https://mcp.test/v1/service",
						transport: "streamable-http",
						headers: {
							Authorization: { secretRef: mcpSecretRef, prefix: "Bearer " },
						},
					},
				},
			},
		};
		raw.secretValues = { ...raw.secretValues, [mcpSecretRef]: mcpSecret };
		raw.sourceRevision = "f".repeat(64);
		const projected = applyRuntimeBundleChannelsToManifestLoad(normalizeHostedRuntimeBundleV2(raw));
		const openclaw = structuredClone(projected.manifest.runtimes.openclaw);
		openclaw.providerMode = "unmanaged";
		openclaw.provider_ids = [];
		delete openclaw.primary_model;
		const projection = structuredClone(projected.manifest.projection);
		if (!projection) throw new Error("runtime bundle projection is unavailable");
		delete projection.providers;
		delete projection.terminalTooling;
		projection.skills = { entries: {} };
		const load = {
			...projected,
			manifest: {
				...projected.manifest,
				runtimes: { openclaw },
				projection,
				skills: { entries: {} },
			},
		};
		const result = convergeRuntimeManifest(load, paths, {});

		expect(result.installErrors).toEqual([]);
		const egressSecretPath = join(paths.managedSecretRoot, "egress-secrets.json");
		const profileBundle = JSON.parse(readFileSync(paths.egressProfileBundle, "utf-8")) as {
			profiles: Array<{
				id: string;
				rewrite?: { setHeaders?: Record<string, { secretRef?: string }> };
			}>;
		};
		const managedClawdiProfile = profileBundle.profiles.find(
			(profile) => profile.id === "managed-mcp-clawdi",
		);
		const managedClawdiSecretRef =
			managedClawdiProfile?.rewrite?.setHeaders?.Authorization?.secretRef;
		expect(managedClawdiSecretRef).toBe("secret://clawdi/auth-token");
		const initialEgressSecrets = JSON.parse(readFileSync(egressSecretPath, "utf-8")) as Record<
			string,
			string
		>;
		expect(initialEgressSecrets[managedClawdiSecretRef ?? ""]).toBe("runtime-auth-token-golden");
		validateGeneratedEgressConfig(paths.egressAddon, paths.egressTransparentEnv);
		const nativeMcpConfig = JSON.parse(readFileSync(openclawConfigPath, "utf-8")) as {
			mcp: { servers: Record<string, unknown> };
		};
		expect(nativeMcpConfig.mcp.servers.clawdi).toEqual({
			url: "https://cloud-api.test/v1/mcp/clawdi",
			transport: "streamable-http",
			headers: {
				Authorization: `Bearer ${managedMcpHeaderPlaceholder("clawdi", "Authorization")}`,
			},
		});
		expect(JSON.stringify(nativeMcpConfig)).not.toContain("runtime-auth-token-golden");
		const watchUnit = readFileSync(
			join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"),
			"utf-8",
		);
		const watchEnvPath = join(paths.systemdEnvRoot, "clawdi-runtime-watch.service.env");
		expect(watchUnit).toContain(`EnvironmentFile=${watchEnvPath}`);
		const watchEnv = readFileSync(watchEnvPath, "utf-8");
		expect(statSync(watchEnvPath).mode & 0o777).toBe(0o600);
		const sidecarOnlySecrets = [
			"runtime-auth-token-golden",
			"sk-provider-golden",
			"123456789:telegram-agent-golden",
			mcpSecret,
		];
		for (const secret of [
			...sidecarOnlySecrets,
			"openclaw-gateway-token-golden",
			"999999999:9ded1453047ec0a48ec3b735075f7448",
		]) {
			expect(watchEnv).not.toContain(secret);
		}
		expect(watchEnv).not.toContain("OPENCLAW_GATEWAY_TOKEN");
		const gatewayEnv = readFileSync(
			join(paths.systemdEnvRoot, "openclaw-gateway.service.env"),
			"utf-8",
		);
		expect(gatewayEnv).not.toContain("OPENCLAW_GATEWAY_TOKEN");
		expect(gatewayEnv).not.toContain("openclaw-gateway-token-golden");
		const persistentLastGood = [
			readFileSync(paths.manifestLastGood, "utf-8"),
			readFileSync(paths.managedSecretCacheFile, "utf-8"),
		].join("\n");
		for (const secret of sidecarOnlySecrets) expect(persistentLastGood).not.toContain(secret);
		for (const secret of sidecarOnlySecrets)
			expect(readFileTree(paths.userHome)).not.toContain(secret);
		const authTokenStat = statSync(paths.daemonAuthToken);
		const egressSecretStat = statSync(egressSecretPath);
		expect(authTokenStat.mode & 0o777).toBe(0o600);
		expect(egressSecretStat.mode & 0o777).toBe(0o600);
		expect(statSync(paths.managedSecretRoot).mode & 0o777).toBe(0o711);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(authTokenStat.uid).toBe(0);
			expect(authTokenStat.gid).toBe(0);
			expect(egressSecretStat.uid).toBe(10_002);
			expect(egressSecretStat.gid).toBe(10_002);
		}
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

		const initialSidecarEnv = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-runtime-sidecar.service.env"),
			"utf-8",
		);
		const initialSidecarRevision = initialSidecarEnv.match(/^CLAWDI_RUNTIME_REV="([^"]+)"$/m)?.[1];
		expect(initialSidecarRevision).toBeTruthy();
		writeFileSync(paths.daemonAuthToken, "deployment-auth-token-rotated\n", { mode: 0o600 });
		if (!load.applyContext) throw new Error("expected runtime apply context");
		const watched = convergeRuntimeManifest(
			{
				...load,
				secretValues: {
					...load.secretValues,
					"secret://clawdi/auth-token": "deployment-auth-token-rotated",
				},
				applyContext: {
					...load.applyContext,
					manifestSource: {
						...load.applyContext.manifestSource,
						auth: { type: "bearer", token: "deployment-auth-token-rotated" },
					},
				},
			},
			paths,
			{},
		);
		expect(watched.installErrors).toEqual([]);
		const reconciledEgressSecrets = JSON.parse(readFileSync(egressSecretPath, "utf-8")) as Record<
			string,
			string
		>;
		expect(reconciledEgressSecrets["secret://clawdi/auth-token"]).toBe(
			"deployment-auth-token-rotated",
		);
		validateGeneratedEgressConfig(paths.egressAddon, paths.egressTransparentEnv);
		const reconciledSidecarEnv = readFileSync(
			join(paths.systemdEnvRoot, "clawdi-runtime-sidecar.service.env"),
			"utf-8",
		);
		const reconciledSidecarRevision = reconciledSidecarEnv.match(
			/^CLAWDI_RUNTIME_REV="([^"]+)"$/m,
		)?.[1];
		expect(reconciledSidecarRevision).toBeTruthy();
		// Secret value rotation is tracked by the root-only applied authority and
		// must not turn the public unit revision into an offline value verifier.
		expect(reconciledSidecarRevision).toBe(initialSidecarRevision);
		expect(reconciledSidecarEnv).not.toContain("deployment-auth-token-rotated");
		expect(readFileSync(paths.daemonAuthToken, "utf-8")).toBe("deployment-auth-token-rotated\n");
		const reconciledPersistentState = [
			readFileSync(paths.manifestLastGood, "utf-8"),
			readFileSync(paths.managedSecretCacheFile, "utf-8"),
			readFileTree(paths.userHome),
		].join("\n");
		expect(reconciledPersistentState).not.toContain("deployment-auth-token");
		expect(reconciledPersistentState).not.toContain("deployment-auth-token-rotated");
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

	test("requires the canonical MCP servers map", () => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: { ...manifest, mcp: { future: true } },
			}),
		).toThrow();
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: { ...manifest, mcp: { servers: { future: true } } },
			}),
		).toThrow();
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					mcp: {
						servers: {
							remote: {
								url: "https://cloud-api.test/v1/mcp/remote",
								transport: "streamable-http",
								headers: { Authorization: { secretRef: "secret://" } },
							},
						},
					},
				},
			}),
		).toThrow();
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					mcp: {
						servers: {
							remote: {
								url: "https://cloud-api.test/v1/mcp/remote",
								transport: "streamable-http",
								headers: { Authorization: "public-a", authorization: "public-b" },
							},
						},
					},
				},
			}),
		).toThrow();
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					mcp: {
						servers: {
							remote: {
								url: "https://cloud-api.test/v1/mcp/remote",
								transport: "streamable-http",
								headers: {
									Authorization: { secretRef: "env://INVALID-NAME" },
								},
							},
						},
					},
				},
			}),
		).toThrow();
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					mcp: {
						servers: {
							clawdi: { command: "clawdi", args: ["mcp"], token: "secret" },
						},
					},
				},
			}),
		).toThrow();
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					mcp: {
						servers: {
							clawdi: {
								url: "https://cloud-api.test/v1/mcp/clawdi",
								transport: "streamable-http",
								headers: { Authorization: { token: "secret" } },
							},
						},
					},
				},
			}),
		).toThrow();
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					skills: { entries: { clawdi: { enabled: true, version: 1 } } },
					mcp: {
						servers: { clawdi: { command: " clawdi", args: ["mcp"] } },
					},
				},
			}),
		).toThrow();
	});

	test.each([
		"Authorization",
		"aUtHoRiZaTiOn",
		"Proxy-Authorization",
		"COOKIE",
		"X-API-Key",
		"X-Client-Token",
		"X-Service-Secret",
		"X-Access-Credential",
	])("rejects literal credential-bearing MCP header %s", (header) => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					mcp: {
						servers: {
							remote: {
								url: "https://mcp.example.test/server",
								transport: "streamable-http",
								headers: { [header]: "literal-value" },
							},
						},
					},
				},
			}),
		).toThrow(/must use secretRef/);
	});

	test("accepts public MCP header literals and secretRef credentials", () => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				manifest: {
					...manifest,
					mcp: {
						servers: {
							remote: {
								url: "https://mcp.example.test/server",
								transport: "streamable-http",
								headers: {
									Accept: "application/json",
									"X-Client-Version": "2026-07-28",
									Authorization: { secretRef: "secret://mcp.remote.token", prefix: "Bearer " },
								},
							},
						},
					},
				},
			}),
		).not.toThrow();
	});

	test("rejects noncanonical channel secret aliases and empty canonical values", () => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const bindings = z.array(z.record(z.string(), z.unknown())).parse(raw.channelBindings);
		const binding = bindings[0];
		if (!binding) throw new Error("golden bundle has no channel binding");
		const secretValues = z.record(z.string(), z.string()).parse(raw.secretValues);
		const canonicalAgentRef = z.string().parse(binding.agentTokenSecretRef);
		const canonicalPlaceholderRef = z.string().parse(binding.placeholderTokenSecretRef);
		const rawAgentRef = canonicalAgentRef.slice("secret://".length);
		const rawPlaceholderRef = canonicalPlaceholderRef.slice("secret://".length);
		const placeholderValue = secretValues[canonicalPlaceholderRef];
		if (!placeholderValue) throw new Error("golden bundle has no placeholder secret value");
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				channelBindings: [{ ...binding, agentTokenSecretRef: rawAgentRef }],
			}),
		).toThrow("must be a canonical non-empty secret:// reference");
		expect(() =>
			normalizeHostedRuntimeBundleV2({
				...raw,
				secretValues: { ...secretValues, [rawPlaceholderRef]: placeholderValue },
			}),
		).toThrow("must be a canonical non-empty secret:// reference");

		const emptyAgentValues = {
			...secretValues,
			[canonicalAgentRef]: "",
		};
		expect(() =>
			applyRuntimeBundleChannelsToManifestLoad(
				normalizeHostedRuntimeBundleV2({
					...raw,
					channelBindings: [{ ...binding, agentTokenSecretRef: canonicalAgentRef }],
					secretValues: emptyAgentValues,
				}),
			),
		).toThrow(`runtime secret value must be non-empty: ${canonicalAgentRef}`);
	});

	test("accepts root apply generation while keeping the inner manifest v1-only and strict", () => {
		const raw = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(readFileSync(goldenPath, "utf-8")));
		const manifest = z.record(z.string(), z.unknown()).parse(raw.manifest);
		const normalized = normalizeHostedRuntimeBundleV2(raw);
		expect(normalized.manifest.projection?.sourceSchemaVersion).toBe(
			"clawdi.hosted-runtime.manifest.v1",
		);
		expect(normalized.manifest.generation).toBe(2);
		expect(normalized.manifest.applyGeneration).toBe(1);
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
		expect(() => normalizeHostedRuntimeBundleV2({ ...raw, unexpectedApplyField: 1 })).toThrow();
		const independentGenerations = normalizeHostedRuntimeBundleV2({
			...raw,
			applyGeneration: 3,
		});
		expect(independentGenerations.manifest.generation).toBe(2);
		expect(independentGenerations.manifest.applyGeneration).toBe(3);
		expect(resolveRuntimeApplyGeneration(independentGenerations.manifest)).toBe(3);
	});

	test("negotiates the exact media type and uses one conditional validator", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const applyContext = setRuntimeApplyIdentityFile(root, {
			generation: 7,
			manifestETag: '"manifest-7"',
			applyReceiptId: "apply-receipt-0007",
			bootNonce: "boot-nonce-000007",
		});
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

		const loaded = await loadRemoteRuntimeManifest(paths, {
			ifNoneMatch: '"bundle-1"',
			applyContext,
		});
		expect(requests).toBe(1);
		expect(loaded).toMatchObject({ notModified: true, etag: '"bundle-1"' });
	});

	test("fails closed when the server returns legacy application/json", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-legacy-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const applyContext = setRuntimeApplyIdentityFile(
			root,
			{
				generation: 1,
				manifestETag: '"bundle-golden"',
				applyReceiptId: "apply-receipt-golden-0001",
				bootNonce: "boot-nonce-golden-000001",
			},
			"clawdi@1.2.3-test",
		);
		const paths = getRuntimePaths({ mode: "hosted" });
		globalThis.fetch = Object.assign(
			async () =>
				new Response(readFileSync(goldenPath, "utf-8"), {
					status: 200,
					headers: { "content-type": "application/json", etag: '"legacy"' },
				}),
			{ preconnect: () => undefined },
		);

		const loaded = await loadRemoteRuntimeManifest(paths, { applyContext });
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
		const applyContext = setRuntimeApplyIdentityFile(
			root,
			{
				generation: 1,
				manifestETag: '"bundle-golden"',
				applyReceiptId: "apply-receipt-golden-0001",
				bootNonce: "boot-nonce-golden-000001",
			},
			"clawdi@1.2.3-test",
		);
		const paths = getRuntimePaths({ mode: "hosted" });
		globalThis.fetch = Object.assign(
			async () =>
				new Response(readFileSync(goldenPath, "utf-8"), {
					status: 200,
					headers: {
						"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
						etag: `"sha256:${EXPECTED_GOLDEN_SOURCE_REVISION}"`,
					},
				}),
			{ preconnect: () => undefined },
		);

		const loaded = await loadRemoteRuntimeManifest(paths, { applyContext });
		if (!("manifest" in loaded)) throw new Error(JSON.stringify(loaded));
		expect(loaded.etag).toBe(`"sha256:${EXPECTED_GOLDEN_SOURCE_REVISION}"`);
		expect(loaded.sourceRevision).toBe(EXPECTED_GOLDEN_SOURCE_REVISION);
		expect(loaded.channelBindings).toHaveLength(1);
	});

	test("rejects a bundle whose HTTP validator does not name its source revision", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-authority-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = "/home/clawdi";
		const applyContext = setRuntimeApplyIdentityFile(
			root,
			{
				generation: 1,
				manifestETag: '"bundle-golden"',
				applyReceiptId: "apply-receipt-golden-0001",
				bootNonce: "boot-nonce-golden-000001",
			},
			"clawdi@1.2.3-test",
		);
		globalThis.fetch = Object.assign(
			async () =>
				new Response(readFileSync(goldenPath, "utf-8"), {
					status: 200,
					headers: {
						"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
						etag: '"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"',
					},
				}),
			{ preconnect: () => undefined },
		);

		const loaded = await loadRemoteRuntimeManifest(getRuntimePaths({ mode: "hosted" }), {
			applyContext,
		});
		expect(loaded).toMatchObject({ mode: "manifest-rejected", stage: "network" });
		expect("errors" in loaded ? loaded.errors.join("\n") : "").toContain(
			"does not match its sourceRevision validator",
		);
	});

	test("caches the effective projected manifest and complete active secret union", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-cache-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const paths = getRuntimePaths({ mode: "hosted" });
		mkdirSync(paths.cacheRoot, { recursive: true });
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
		expect(secretCache).toContain("telegram-agent-golden");
		expect(secretCache).toContain("sk-provider-golden");
		expect(secretCache).not.toContain("channelBindings");
		expect(secretCache).not.toContain("sourceRevision");
		const cacheStat = statSync(paths.managedSecretCacheFile);
		expect(cacheStat.mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(cacheStat.uid).toBe(0);
			expect(cacheStat.gid).toBe(0);
		}
	});

	test("rebuilds the exact active egress secret file from the golden bundle offline", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-bundle-offline-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "run", "systemd", "system");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_HOME = join(root, "clawdi-home");
		process.env.HOME = process.env.CLAWDI_RUNTIME_HOME;
		process.env.CLAWDI_AUTH_TOKEN = "test-token";
		process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		process.env.CLAWDI_EGRESS_UID = "10002";
		process.env.CLAWDI_EGRESS_GID = "10002";
		process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
		const applyContext = setRuntimeApplyIdentityFile(
			root,
			{
				generation: 1,
				manifestETag: '"bundle-golden"',
				applyReceiptId: "apply-receipt-golden-0001",
				bootNonce: "boot-nonce-golden-000001",
			},
			"clawdi@1.2.3-test",
		);
		const paths = getRuntimePaths({ mode: "hosted" });
		const goldenRaw = JSON.parse(readFileSync(goldenPath, "utf-8")) as {
			sourceRevision: string;
			manifest: { egressEngine: { version: string; sha256: string } };
		};
		expect(goldenRaw.sourceRevision).toBe(EXPECTED_GOLDEN_SOURCE_REVISION);
		const goldenEngine = goldenRaw.manifest.egressEngine;
		const goldenMitmdump = join(
			paths.egressEngineMaintainedRoot,
			goldenEngine.version,
			goldenEngine.sha256,
			"mitmdump",
		);
		mkdirSync(dirname(goldenMitmdump), { recursive: true });
		writeFileSync(goldenMitmdump, "#!/usr/bin/env sh\nexit 0\n");
		chmodSync(goldenMitmdump, 0o755);
		const openclawBin = join(paths.userHome, ".local", "bin", "openclaw");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(join(paths.userHome, ".openclaw"), { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env sh
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"%s"}]\\n' "$HOME/.openclaw/workspace"
  exit 0
fi
cat >/dev/null || true
exit 0
`,
		);
		chmodSync(openclawBin, 0o700);

		let networkAvailable = true;
		globalThis.fetch = Object.assign(
			async () => {
				if (!networkAvailable) throw new Error("control plane unavailable");
				return new Response(readFileSync(goldenPath, "utf-8"), {
					status: 200,
					headers: {
						"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
						etag: `"sha256:${EXPECTED_GOLDEN_SOURCE_REVISION}"`,
					},
				});
			},
			{ preconnect: () => undefined },
		);
		const converge = (load: Parameters<typeof convergeRuntimeManifest>[0]) =>
			convergeRuntimeManifest(load, paths, {
				cacheLastGood: false,
			});

		const remote = await loadRemoteRuntimeManifest(paths, { applyContext });
		if (!("manifest" in remote)) throw new Error(JSON.stringify(remote));
		const onlineLoad = applyRuntimeBundleChannelsToManifestLoad(remote);
		if (onlineLoad.manifest.projection) {
			onlineLoad.manifest.projection.skills = { entries: {} };
		}
		const onlineConvergence = converge(onlineLoad);
		expect(onlineConvergence.installErrors).toEqual([]);
		const sourceRevision = onlineLoad.sourceRevision;
		if (!sourceRevision) throw new Error("golden bundle has no source revision");
		commitRuntimeAppliedState({
			load: onlineLoad,
			paths,
			etag: remote.etag ?? '"bundle-golden"',
			sourceRevision,
			convergence: onlineConvergence,
			applyIdentity: {
				generation: 1,
				manifestETag: '"bundle-golden"',
				applyReceiptId: "apply-receipt-golden-0001",
				bootNonce: "boot-nonce-golden-000001",
			},
		});

		const cacheText = readFileSync(paths.managedSecretCacheFile, "utf-8");
		const cachedSecrets = z.record(z.string(), z.string()).parse(JSON.parse(cacheText));
		const agentRef =
			"secret://channels/telegram/clawdi_50000000000000000000000000000005/agent-token";
		const placeholderRef =
			"secret://channels/telegram/clawdi_50000000000000000000000000000005/placeholder-token";
		const providerRef = "secret://tool.codex.apiKey";
		expect(cachedSecrets).toMatchObject({
			[agentRef]: "123456789:telegram-agent-golden",
			[placeholderRef]: "999999999:9ded1453047ec0a48ec3b735075f7448",
			[providerRef]: "sk-provider-golden",
			"secret://runtime/openclaw/gateway-token": "openclaw-gateway-token-golden",
		});
		expect(cachedSecrets).not.toHaveProperty("unused.secret");
		const cacheStat = statSync(paths.managedSecretCacheFile);
		expect(cacheStat.mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(cacheStat.uid).toBe(0);
			expect(cacheStat.gid).toBe(0);
		}

		const applied = readRuntimeAppliedState(paths);
		if (!applied) throw new Error("online apply did not commit durable authority");
		expect(applied.generation).toBe(2);
		expect(applied.applyGeneration).toBe(1);
		const appliedStateText = readFileSync(paths.appliedState, "utf-8");
		const appliedStateStat = statSync(paths.appliedState);
		expect(appliedStateStat.mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(appliedStateStat.uid).toBe(0);
			expect(appliedStateStat.gid).toBe(0);
		}
		const canonicalContentSha = runtimeContentSha256({
			manifest: onlineLoad.manifest,
			secretValues: cachedSecrets,
		});
		expect(applied.contentIdentity.sha256).toBe(canonicalContentSha);
		expect(runtimeAppliedContentIdentity(onlineLoad).sha256).toBe(canonicalContentSha);

		const egressSecretFile = onlineConvergence.outputs.egressSecretFile;
		if (!egressSecretFile) throw new Error("online converge did not write egress secrets");
		const onlineEgressSecretText = readFileSync(egressSecretFile, "utf-8");
		const onlineEgressSecretStat = statSync(egressSecretFile);
		expect(onlineEgressSecretStat.mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(onlineEgressSecretStat.uid).toBe(10002);
			expect(onlineEgressSecretStat.gid).toBe(10002);
		}
		const manifestCacheText = readFileSync(paths.manifestLastGood, "utf-8");
		const generatedUnitPaths = [...onlineConvergence.outputs.systemdSystemUnits];
		for (const unitPath of onlineConvergence.outputs.systemdUserUnits) {
			const candidates = [unitPath, join(`${unitPath}.d`, "10-clawdi-hosted.conf")].filter(
				existsSync,
			);
			expect(candidates).not.toEqual([]);
			generatedUnitPaths.push(...candidates);
		}
		for (const unitPath of generatedUnitPaths) expect(existsSync(unitPath)).toBe(true);
		for (const unitName of ["clawdi-runtime-watch.service", "clawdi-daemon.service"]) {
			const unitPath = join(paths.systemdSystemRoot, unitName);
			expect(onlineConvergence.outputs.systemdSystemUnits).toContain(unitPath);
			expect(readFileSync(unitPath, "utf-8")).not.toMatch(/^User=/m);
		}
		for (const secret of [
			"123456789:telegram-agent-golden",
			"999999999:9ded1453047ec0a48ec3b735075f7448",
			"sk-provider-golden",
		]) {
			expect(manifestCacheText).not.toContain(secret);
			expect(appliedStateText).not.toContain(secret);
			for (const unitPath of generatedUnitPaths) {
				expect(readFileSync(unitPath, "utf-8")).not.toContain(secret);
			}
			expect(readFileSync(paths.providerHealthStatus, "utf-8")).not.toContain(secret);
		}

		rmSync(egressSecretFile);
		expect(existsSync(egressSecretFile)).toBe(false);
		networkAvailable = false;
		setRuntimeApplyIdentityFile(root, {
			generation: 1,
			manifestETag: '"bundle-golden"',
			applyReceiptId: "apply-receipt-golden-0001",
			bootNonce: "boot-nonce-golden-000001",
		});
		const offlineLoad = await loadRuntimeManifest(paths, { applyContext });
		if (!("manifest" in offlineLoad)) throw new Error(JSON.stringify(offlineLoad));
		expect(offlineLoad.source).toBe("last-good-cache");
		expect(offlineLoad.offline).toBe(true);
		expect(offlineLoad.manifest.generation).toBe(2);
		expect(offlineLoad.manifest.applyGeneration).toBe(1);
		expect(runtimeAppliedContentIdentity(offlineLoad).sha256).toBe(canonicalContentSha);
		const offlineConvergence = converge(offlineLoad);
		expect(offlineConvergence.mode).toBe("degraded-offline");
		expect(offlineConvergence.installErrors).toEqual([]);
		expect(readFileSync(egressSecretFile, "utf-8")).toBe(onlineEgressSecretText);
		const offlineEgressSecretStat = statSync(egressSecretFile);
		expect(offlineEgressSecretStat.mode & 0o777).toBe(0o600);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(offlineEgressSecretStat.uid).toBe(10002);
			expect(offlineEgressSecretStat.gid).toBe(10002);
		}

		rmSync(paths.appliedState);
		const uncommittedCacheLoad = await loadRuntimeManifest(paths, { applyContext });
		expect("errors" in uncommittedCacheLoad).toBe(true);
		if (!("errors" in uncommittedCacheLoad)) {
			throw new Error("expected uncommitted strict-v2 cache failure");
		}
		expect(uncommittedCacheLoad.errors.join("\n")).toContain(
			"cached strict-v2 apply identity does not match the current runtime apply identity",
		);
		writeFileSync(paths.appliedState, appliedStateText);
		setRuntimeApplyIdentityFile(root, {
			generation: 1,
			manifestETag: '"bundle-golden"',
			applyReceiptId: "apply-receipt-golden-0001",
			bootNonce: "boot-nonce-golden-000001",
		});

		const committedManifest = z
			.record(z.string(), z.unknown())
			.parse(JSON.parse(manifestCacheText));
		writeFileSync(
			paths.manifestLastGood,
			`${JSON.stringify({
				...committedManifest,
				generation: onlineLoad.manifest.generation + 1,
			})}\n`,
		);
		const manifestOnlyCrashLoad = await loadRuntimeManifest(paths, { applyContext });
		expect("errors" in manifestOnlyCrashLoad).toBe(true);
		if (!("errors" in manifestOnlyCrashLoad)) {
			throw new Error("expected manifest-only mixed snapshot failure");
		}
		expect(manifestOnlyCrashLoad.errors.join("\n")).toContain(
			"cached manifest does not match the durable strict-v2 apply identity",
		);
		writeFileSync(
			paths.manifestLastGood,
			`${JSON.stringify({ ...committedManifest, applyGeneration: 2 })}\n`,
		);
		const applyOnlyCrashLoad = await loadRuntimeManifest(paths, { applyContext });
		expect("errors" in applyOnlyCrashLoad).toBe(true);
		if (!("errors" in applyOnlyCrashLoad)) {
			throw new Error("expected apply-generation mixed snapshot failure");
		}
		expect(applyOnlyCrashLoad.errors.join("\n")).toContain(
			"cached manifest does not match the durable strict-v2 apply identity",
		);
		writeFileSync(paths.manifestLastGood, manifestCacheText);
		writeFileSync(
			paths.managedSecretCacheFile,
			`${JSON.stringify({
				...cachedSecrets,
				[agentRef]: "123456789:telegram-agent-next",
			})}\n`,
		);
		const manifestAndSecretsCrashLoad = await loadRuntimeManifest(paths, { applyContext });
		expect("errors" in manifestAndSecretsCrashLoad).toBe(true);
		if (!("errors" in manifestAndSecretsCrashLoad)) {
			throw new Error("expected manifest-plus-secret mixed snapshot failure");
		}
		expect(manifestAndSecretsCrashLoad.errors.join("\n")).toContain(
			"cached manifest does not match the durable strict-v2 apply identity",
		);
		writeFileSync(paths.manifestLastGood, manifestCacheText);
		writeFileSync(paths.managedSecretCacheFile, cacheText);
		const restoredCommittedLoad = await loadRuntimeManifest(paths, { applyContext });
		expect("manifest" in restoredCommittedLoad).toBe(true);

		const missingSecrets = { ...cachedSecrets };
		delete missingSecrets[agentRef];
		writeFileSync(paths.managedSecretCacheFile, `${JSON.stringify(missingSecrets)}\n`);
		const missingLoad = await loadRuntimeManifest(paths, { applyContext });
		expect("errors" in missingLoad).toBe(true);
		if (!("errors" in missingLoad)) throw new Error("expected missing cache failure");
		expect(missingLoad.errors.join("\n")).toContain("cached secret values are missing");

		const staleSecrets = {
			...cachedSecrets,
			[providerRef]: "sk-provider-stale",
		};
		writeFileSync(paths.managedSecretCacheFile, `${JSON.stringify(staleSecrets)}\n`);
		const staleLoad = await loadRuntimeManifest(paths, { applyContext });
		expect("errors" in staleLoad).toBe(true);
		if (!("errors" in staleLoad)) throw new Error("expected stale cache failure");
		expect(staleLoad.errors.join("\n")).toContain(
			"cached manifest does not match the durable strict-v2 apply identity",
		);
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
