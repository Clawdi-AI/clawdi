import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
	applyConnectionProviderTransfers,
	type ConnectionProviderOwnership,
	prepareConnectionProviderTransfers,
} from "./connection-provider-config";
import { getHermesRawConfigValue, type HermesConfigTransaction } from "./hermes-config";
import { createOpenClawHostedContext } from "./hosted-openclaw-context";
import {
	hostedProviderConfiguration,
	hostedProviderEnvironment,
} from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeInstallObservation } from "./manifest-install";
import { applyHostedAiProviderProjection } from "./manifest-providers";
import { recordValue } from "./manifest-shared";
import { getRuntimePaths } from "./paths";
import {
	commitProviderTransfers,
	readProviderOwnership,
	writeProviderOwnership,
} from "./provider-ownership";

const id = "saved-provider";
const envName = "SAVED_PROVIDER_API_KEY";
const baseUrl = "https://provider.example/v1";

function fixture(runtime: "openclaw" | "hermes", mode: "custom" | "connection" = "connection") {
	const home = mkdtempSync(join(tmpdir(), "clawdi-connection-"));
	const manifest: RuntimeManifest = {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "test",
		environmentId: "test",
		instanceId: "test",
		generation: 1,
		issuedAt: "2026-09-08T00:00:00Z",
		runtime,
		controlPlane: { apiUrl: "https://core.example.test" },
		recovery: {},
		runtimes: {
			[runtime]: {
				enabled: true,
				providerMode: "configured",
				provider_ids: [id],
				primary_model: null,
				services: {},
			},
		},
		projection: {
			providers: {
				[id]: {
					kind: "openai-compatible",
					type: "custom_openai_compatible",
					configurationMode: mode,
					managed_by: "user",
					baseUrl,
					apiMode: "openai_chat",
					runtimeEnvName: envName,
					apiKeySecretRef: "secret://provider.saved-provider.apiKey",
				},
			},
		},
	};
	const openClawContext = createOpenClawHostedContext(manifest, home);
	if (runtime === "openclaw")
		manifest.openclawGatewayAuth = {
			mode: "token",
			tokenRef: "secret://runtime/openclaw/gateway-token",
			deviceAuthRequired: false,
			activation: { enabled: true, capability: "openclaw-native-auth-v1" },
		};
	mkdirSync(openClawContext.stateRoot, { recursive: true });
	const command = join(home, "native-config");
	writeFileSync(
		command,
		`#!/usr/bin/env python3
import json, os, sys
assert sys.argv[1:] == ["config", "patch", "--stdin"]
path = os.path.join(os.path.dirname(__file__), ".openclaw", "openclaw.json")
with open(path) as file: config = json.load(file)
def merge(target, patch):
    for key, value in patch.items():
        if value is None: target.pop(key, None)
        elif isinstance(value, dict): merge(target.setdefault(key, {}), value)
        else: target[key] = value
merge(config, json.load(sys.stdin))
with open(path, "w") as file: json.dump(config, file)
`,
		{ mode: 0o755 },
	);
	const provider =
		runtime === "openclaw"
			? {
					baseUrl,
					auth: "api-key",
					apiKey: { source: "env", provider: "default", id: envName },
					models: [{ id: "existing", name: "Existing", params: { temperature: 0.4 } }],
					params: { custom: true },
				}
			: {
					api: baseUrl,
					transport: "chat_completions",
					key_env: envName,
					models: { existing: { context_length: 8192 } },
					extra_body: { custom: true },
				};
	writeFileSync(
		openClawContext.configPath,
		JSON.stringify({
			models: { mode: "replace", providers: { [id]: provider } },
			agents: { defaults: { model: { primary: `${id}/existing` } } },
		}),
	);
	const document = parseDocument(
		JSON.stringify({
			providers: { [id]: provider },
			model: { provider: `custom:${id}`, default: "existing" },
		}),
	);
	const hermesConfig: HermesConfigTransaction = {
		context: { command, home, cwd: home },
		path: join(home, ".hermes/config.yaml"),
		sourceContent: document.toString(),
		document,
		changed: false,
	};
	if (runtime === "hermes") {
		const app = join(home, ".hermes/hermes-agent");
		for (const directory of ["agent", "hermes_cli", "venv/bin"])
			mkdirSync(join(app, directory), { recursive: true });
		// Public API contract doubles; no private pool layout knowledge in the adapter.
		writeFileSync(
			join(app, "agent/credential_pool.py"),
			"def custom_provider_pool_key_candidates(base_url, provider_name=None):\n    return [provider_name]\n",
		);
		writeFileSync(
			join(app, "hermes_cli/auth.py"),
			"import os\ndef read_credential_pool(key):\n    return [object()] if os.path.exists(os.path.join(os.environ['HERMES_HOME'], 'pool-conflict')) else []\n",
		);
		symlinkSync("/usr/bin/python3", join(app, "venv/bin/python"));
	}
	const observation: RuntimeInstallObservation = {
		runtime,
		enabled: true,
		status: "present",
		commandPath: command,
		executionUser: null,
		appRoot: null,
		install: null,
		installerUrl: null,
		executedInstallerUrl: null,
		exitCode: null,
		error: null,
	};
	let ownership: ConnectionProviderOwnership = { providers: {} };
	const secretValues: Record<string, string> = {
		"secret://provider.saved-provider.apiKey": "test-key-one",
		"secret://runtime/openclaw/gateway-token": "test-gateway-token",
	};
	const input = () => ({
		runtime,
		manifest,
		observation,
		home,
		openClawContext,
		workspaceRoot: home,
		hermesConfig,
		secretValues,
		ownership,
	});
	const prepare = () => {
		const prepared = prepareConnectionProviderTransfers(input());
		ownership = { providers: prepared.providers, prepared };
		return prepared;
	};
	const read = () =>
		runtime === "hermes"
			? recordValue(getHermesRawConfigValue(hermesConfig, "providers").value)?.[id]
			: JSON.parse(readFileSync(openClawContext.configPath, "utf8")).models.providers[id];
	const set = (value: unknown) => {
		if (runtime === "hermes") {
			if (value === undefined) document.deleteIn(["providers", id]);
			else document.setIn(["providers", id], value);
		} else {
			const config = JSON.parse(readFileSync(openClawContext.configPath, "utf8"));
			config.models.providers[id] = value;
			writeFileSync(openClawContext.configPath, JSON.stringify(config));
		}
	};
	return {
		home,
		manifest,
		input,
		prepare,
		read,
		set,
		secretValues,
		restoreOwnership: (providers: ConnectionProviderOwnership["providers"]) => {
			ownership = { providers };
		},
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
}

function applyProjector(f: ReturnType<typeof fixture>, previousProviderIds: string[] = [id]) {
	const input = f.input();
	return applyHostedAiProviderProjection(
		input.runtime,
		input.observation,
		input.manifest,
		input.secretValues,
		input.home,
		input.openClawContext,
		input.workspaceRoot,
		previousProviderIds,
		false,
		input.hermesConfig,
		"test-revision",
		[],
		input.ownership,
	);
}

for (const runtime of ["openclaw", "hermes"] as const) {
	test(`${runtime}: custom creation, retry, rotation and rebind preserve agent-owned models`, () => {
		const f = fixture(runtime, "custom");
		try {
			f.set(undefined);
			const plan = f.prepare();
			expect(plan.providers[id]?.pendingCreation).toBe(true);
			// Crash after the durable write-ahead record, before config creation.
			f.restoreOwnership(plan.providers);
			f.prepare();
			applyConnectionProviderTransfers(f.input());
			const provider = recordValue(f.read()) ?? {};
			expect(provider.apiKey ?? provider.key_env).toBeDefined();
			if (runtime === "openclaw") expect(provider.models).toEqual([]);
			else expect(provider.models).toBeUndefined();
			f.restoreOwnership(commitProviderTransfers({ [runtime]: plan.providers })[runtime]);
			const edited = {
				...provider,
				models:
					runtime === "openclaw"
						? [{ id: "tenant-model", name: "Tenant model" }]
						: { "tenant-model": {} },
				tenant_option: "keep",
			};
			f.set(edited);
			f.secretValues["secret://provider.saved-provider.apiKey"] = "rotated-test-key";
			f.prepare();
			applyConnectionProviderTransfers(f.input());
			expect(f.read()).toEqual(edited);
			f.manifest.runtimes[runtime].provider_ids = [];
			f.prepare();
			applyConnectionProviderTransfers(f.input());
			expect(recordValue(f.read())?.models).toEqual(edited.models);
			expect(recordValue(f.read())?.apiKey ?? recordValue(f.read())?.key_env).toBeUndefined();
			f.manifest.runtimes[runtime].provider_ids = [id];
			f.prepare();
			applyConnectionProviderTransfers(f.input());
			expect(f.read()).toEqual(edited);
			if (runtime === "hermes") {
				const config = f.input().hermesConfig;
				config.document.setIn(["model", "base_url"], baseUrl);
				config.document.setIn(["model", "api_mode"], "chat_completions");
				f.prepare();
				applyConnectionProviderTransfers(f.input());
				const desired = f.manifest.projection?.providers?.[id];
				if (!desired) throw new Error("Missing provider fixture");
				desired.baseUrl = "https://updated.example/v1";
				f.prepare();
				applyConnectionProviderTransfers(f.input());
				expect(config.document.getIn(["model", "base_url"])).toBe(desired.baseUrl);
				expect(config.document.getIn(["model", "default"])).toBe("existing");
				expect(recordValue(f.read())?.models).toEqual(edited.models);
			}
			// A successful initialization is not permission to recreate a user-deleted row.
			f.set(undefined);
			expect(() => f.prepare()).toThrow("must already exist");
		} finally {
			f.cleanup();
		}
	});

	test(`${runtime}: explicit catalog primary supersedes connection selection despite permanent tombstone`, () => {
		const f = fixture(runtime);
		try {
			const original = recordValue(f.read());
			f.prepare();
			applyProjector(f);
			const nextId = "next-provider";
			f.manifest.runtimes[runtime].provider_ids = [nextId];
			f.manifest.runtimes[runtime].primary_model = { provider_id: nextId, model: "next-model" };
			f.manifest.projection = {
				providers: {
					[nextId]: {
						kind: "openai-compatible",
						type: "custom_openai_compatible",
						configurationMode: "catalog",
						managed_by: "user",
						baseUrl: "https://next.example/v1",
						apiMode: "openai_chat",
						runtimeEnvName: "NEXT_PROVIDER_KEY",
						apiKeySecretRef: "secret://provider.next.apiKey",
						models: [{ id: "next-model" }],
					},
				},
			};
			f.secretValues["secret://provider.next.apiKey"] = "next-test-key";
			const input = f.input();
			if (runtime === "openclaw") {
				const config = JSON.parse(readFileSync(input.openClawContext.configPath, "utf8"));
				config.models.mode = "merge";
				writeFileSync(input.openClawContext.configPath, JSON.stringify(config));
				const sdkPath = join(f.home, "config-mutation.mjs");
				writeFileSync(
					sdkPath,
					`import {readFileSync, writeFileSync} from "node:fs";
const path = ${JSON.stringify(input.openClawContext.configPath)};
export async function readConfigFileSnapshotForWrite() {
    return {snapshot: {valid: true, sourceConfig: JSON.parse(readFileSync(path, "utf8"))}};
}
export async function mutateConfigFile(options) {
    const config = JSON.parse(readFileSync(path, "utf8"));
    await options.mutate(config);
    writeFileSync(path, JSON.stringify(config));
}
`,
				);
				input.openClawContext.sdk.configMutation = sdkPath;
			}
			f.prepare();
			const result = applyProjector(f);
			expect(result.providerIds).toEqual([nextId]);
			expect(f.input().ownership.providers[id]).toBeDefined();
			const retained = recordValue(f.read());
			expect(retained?.models).toEqual(original?.models);
			expect(retained?.apiKey ?? retained?.key_env).toBeUndefined();
			expect(runtime === "openclaw" ? retained?.baseUrl : retained?.api).toBe(baseUrl);
			if (runtime === "hermes") {
				expect(getHermesRawConfigValue(input.hermesConfig, "model.provider").value).toBe(
					`custom:${nextId}`,
				);
				expect(getHermesRawConfigValue(input.hermesConfig, "model.default").value).toBe(
					"next-model",
				);
			} else {
				const config = JSON.parse(readFileSync(input.openClawContext.configPath, "utf8"));
				expect(config.agents.defaults.model.primary).toBe(`${nextId}/next-model`);
				expect(config.models.mode).toBe("replace");
			}
		} finally {
			f.cleanup();
		}
	});

	test(`${runtime}: journal persisted before any config write still permits auth-only unbind`, () => {
		const f = fixture(runtime);
		try {
			const before = f.read();
			const plan = f.prepare();
			const paths = { ...getRuntimePaths(), serviceStateRoot: join(f.home, "journal") };
			mkdirSync(paths.serviceStateRoot);
			const journal = readProviderOwnership(paths, "test", f.home, { [runtime]: [id] });
			journal.transfers[runtime] = plan.providers;
			writeProviderOwnership(paths, "test", f.home, journal);
			// Simulate process loss here: do not apply the prepared native config patch.
			expect(f.read()).toEqual(before);
			const recovered = readProviderOwnership(paths, "test", f.home, { [runtime]: [id] });
			f.restoreOwnership(recovered.transfers[runtime] ?? {});
			f.manifest.runtimes[runtime].provider_ids = [];
			f.manifest.runtimes[runtime].providerMode = "unmanaged";
			f.prepare();
			applyProjector(f);
			const after = recordValue(f.read());
			expect(after?.models).toEqual(recordValue(before)?.models);
			expect(runtime === "openclaw" ? after?.baseUrl : after?.api).toBe(baseUrl);
			expect(after?.apiKey ?? after?.key_env).toBeUndefined();
			expect(recovered.providers[runtime]).toEqual([]);
		} finally {
			f.cleanup();
		}
	});

	test(`${runtime}: migration, failed authority and unbind retain the handed-off provider`, () => {
		const f = fixture(runtime);
		try {
			const before = f.read();
			expect(hostedProviderConfiguration(f.manifest, runtime).catalog).toBeNull();
			const plan = f.prepare();
			const paths = { ...getRuntimePaths(), serviceStateRoot: join(f.home, "journal") };
			mkdirSync(paths.serviceStateRoot);
			const journal = readProviderOwnership(paths, "test", f.home, { [runtime]: [id] });
			journal.transfers[runtime] = plan.providers;
			writeProviderOwnership(paths, "test", f.home, journal);
			applyConnectionProviderTransfers(f.input());
			// The previous applied state never advanced. Durable transfer still defeats its stale catalog ID.
			const recovered = readProviderOwnership(paths, "test", f.home, { [runtime]: [id] });
			expect(recovered.providers[runtime]).toEqual([]);
			f.manifest.runtimes[runtime].provider_ids = [];
			f.manifest.runtimes[runtime].providerMode = "unmanaged";
			f.prepare();
			applyConnectionProviderTransfers(f.input());
			const after = recordValue(f.read());
			const original = recordValue(before);
			expect(after?.models).toEqual(original?.models);
			expect(runtime === "openclaw" ? after?.baseUrl : after?.api).toBe(baseUrl);
			expect(after?.apiKey ?? after?.key_env).toBeUndefined();
		} finally {
			f.cleanup();
		}
	});

	test(`${runtime}: rotation preserves user model edits; preflight rejects route/auth conflicts without writes`, () => {
		const f = fixture(runtime);
		try {
			const original = recordValue(f.read()) ?? {};
			f.set(undefined);
			expect(() => f.prepare()).toThrow("must already exist");
			f.set({
				...original,
				...(runtime === "openclaw" ? { apiKey: "foreign-key" } : { key_cmd: "foreign-command" }),
			});
			expect(() => f.prepare()).toThrow("credential ownership conflict");
			if (runtime === "openclaw") {
				for (const fields of [
					{ authHeader: false },
					{ headers: { Authorization: "user-token" } },
					{
						models: [
							{ id: "existing", name: "Existing", headers: { "X-Goog-API-Key": "user-key" } },
						],
					},
				]) {
					f.set({ ...original, ...fields });
					const before = f.read();
					expect(() => f.prepare()).toThrow("authentication header conflict");
					expect(f.read()).toEqual(before);
				}
			}
			f.set({
				...original,
				...(runtime === "openclaw"
					? { baseUrl: "https://changed.example/v1" }
					: { api: "https://changed.example/v1" }),
			});
			const conflict = f.read();
			expect(() => f.prepare()).toThrow("routing changed");
			expect(f.read()).toEqual(conflict);
			f.set(original);
			f.prepare();
			applyConnectionProviderTransfers(f.input());
			const edited = {
				...recordValue(f.read()),
				models:
					runtime === "openclaw"
						? [{ id: "user-model", name: "User model" }]
						: { "user-model": {} },
			};
			f.set(edited);
			f.prepare();
			applyConnectionProviderTransfers({
				...f.input(),
				secretValues: { "secret://provider.saved-provider.apiKey": "test-key-rotated" },
			});
			expect(f.read()).toEqual(edited);
			expect(hostedProviderEnvironment(f.manifest, runtime).secretEnv).toEqual({
				[envName]: "secret://provider.saved-provider.apiKey",
			});
			f.prepare();
			f.set({ ...edited, models: [] });
			expect(() => applyConnectionProviderTransfers(f.input())).toThrow("changed after preflight");
		} finally {
			f.cleanup();
		}
	});
}

test("Hermes public pool conflict prevents ownership transfer and config mutation", () => {
	const f = fixture("hermes");
	try {
		writeFileSync(join(f.home, ".hermes/pool-conflict"), "present");
		const before = f.read();
		expect(() => f.prepare()).toThrow("credential conflict");
		expect(f.read()).toEqual(before);
		expect(f.input().ownership.providers).toEqual({});
	} finally {
		f.cleanup();
	}
});

test.each(["empty", "occupied", "no-match"])(
	"Hermes uses the installed legacy public pool resolver: %s",
	(state) => {
		const f = fixture("hermes");
		try {
			const app = join(f.home, ".hermes/hermes-agent");
			writeFileSync(
				join(app, "agent/credential_pool.py"),
				`def get_custom_provider_pool_key(base_url, provider_name=None):\n    return ${state === "no-match" ? "None" : '"custom:resolved-by-native"'}\n`,
			);
			writeFileSync(
				join(app, "hermes_cli/auth.py"),
				state === "no-match"
					? "def read_credential_pool(key):\n    raise AssertionError('No native pool matched')\n"
					: `def read_credential_pool(key):\n    assert key == "custom:resolved-by-native"\n    return ${state === "occupied" ? "[object()]" : "[]"}\n`,
			);
			const before = f.read();
			if (state === "occupied") {
				expect(() => f.prepare()).toThrow("credential conflict");
				expect(f.input().ownership.providers).toEqual({});
			} else {
				f.prepare();
				expect(f.input().ownership.providers[id]?.envName).toBe(envName);
			}
			expect(f.read()).toEqual(before);
		} finally {
			f.cleanup();
		}
	},
);

test("Hermes refuses unknown public pool APIs", () => {
	const f = fixture("hermes");
	try {
		writeFileSync(join(f.home, ".hermes/hermes-agent/agent/credential_pool.py"), "pass\n");
		expect(() => f.prepare()).toThrow("unsupported public pool API");
		expect(f.input().ownership.providers).toEqual({});
	} finally {
		f.cleanup();
	}
});
