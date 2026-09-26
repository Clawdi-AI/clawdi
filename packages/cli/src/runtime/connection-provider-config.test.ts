import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
	applyConnectionProviderTransfers,
	type ConnectionProviderConflictCode,
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

/** Native ownership wins: the connection is skipped, its journal entry kept, nothing written. */
function expectNativeWins(
	f: ReturnType<typeof fixture>,
	code: ConnectionProviderConflictCode = "native_provider_exists",
) {
	const before = f.read();
	const previous = f.input().ownership.providers;
	const plan = f.prepare();
	expect(plan.conflicts).toEqual({ [id]: code });
	expect(plan.patch).toEqual({});
	expect(plan.hermesModelRouting).toBeUndefined();
	expect(plan.providers).toEqual(previous);
	expect(applyConnectionProviderTransfers(f.input())).toBe(false);
	expect(f.read()).toEqual(before);
}

for (const runtime of ["openclaw", "hermes"] as const) {
	test(`${runtime}: upgrading an unmarked legacy binding converges without inventing a Cloud tuple`, () => {
		const f = fixture(runtime, "custom");
		try {
			const plan = f.prepare();
			applyConnectionProviderTransfers(f.input());
			const paths = { ...getRuntimePaths(), serviceStateRoot: join(f.home, "legacy-journal") };
			mkdirSync(paths.serviceStateRoot);
			writeProviderOwnership(paths, "test", f.home, {
				providers: { [runtime]: [] },
				transfers: { openclaw: {}, hermes: {}, [runtime]: plan.providers },
			});
			const loaded = readProviderOwnership(paths, "test", f.home, { [runtime]: [id] });
			f.restoreOwnership(loaded.transfers[runtime] ?? {});
			const before = f.read();
			f.prepare();
			applyProjector(f);
			expect(f.read()).toEqual(before);
			expect(f.input().ownership.providers[id]?.cloudIdentity).toBeUndefined();
			const provider = f.manifest.projection?.providers?.[id];
			if (!provider) throw new Error("Missing fixture provider");
			// A Clawdi-held credential in the same environment adopts its first Cloud identity.
			const identity = { providerUuid: randomUUID(), incarnationId: randomUUID() };
			provider.cloudIdentity = identity;
			expect(f.prepare().providers[id]?.cloudIdentity).toEqual(identity);
			applyProjector(f);
			expect(f.read()).toEqual(before);
			f.restoreOwnership(
				commitProviderTransfers({ [runtime]: f.input().ownership.providers })[runtime],
			);
			f.prepare();
			// A different recorded identity is a reincarnation and still needs a handoff.
			provider.cloudIdentity = { providerUuid: randomUUID(), incarnationId: randomUUID() };
			expect(() => f.prepare()).toThrow("explicit operator handoff");
			provider.cloudIdentity = identity;
			// Native credential authority never adopts an unmarked journal entry.
			f.restoreOwnership(loaded.transfers[runtime] ?? {});
			provider.credentialAuthority = "native";
			expect(() => f.prepare()).toThrow("acknowledged identity handoff");
			expect(f.read()).toEqual(before);
		} finally {
			f.cleanup();
		}
	});

	test(`${runtime}: custom creation, retry, rotation and rebind preserve agent-owned models`, () => {
		const f = fixture(runtime, "custom");
		try {
			f.set(undefined);
			const plan = f.prepare();
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
			const desired = f.manifest.projection?.providers?.[id];
			if (!desired) throw new Error("Missing provider fixture");
			const unbound = f.read();
			desired.runtimeEnvName = "RECREATED_PROVIDER_API_KEY";
			expect(() => f.prepare()).toThrow("Connection credential environment is immutable");
			expect(f.read()).toEqual(unbound);
			desired.runtimeEnvName = envName;
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
			// The binding still declares a Clawdi-owned provider, so a deleted row is recreated
			// with Clawdi's own credential reference.
			f.set(undefined);
			f.prepare();
			applyConnectionProviderTransfers(f.input());
			const recreated = recordValue(f.read());
			expect(recreated?.apiKey ?? recreated?.key_env).toBeDefined();
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

	test(`${runtime}: native credential handoff survives unbinding without clearing its reference`, () => {
		const f = fixture(runtime);
		try {
			const plan = f.prepare();
			applyConnectionProviderTransfers(f.input());
			const before = f.read();
			const transfer = plan.providers[id];
			if (!transfer) throw new Error("Missing test transfer");
			f.restoreOwnership({
				[id]: {
					...transfer,
					handoffId: randomUUID(),
					cloudIdentity: { providerUuid: randomUUID(), incarnationId: randomUUID() },
				},
			});
			f.manifest.runtimes[runtime].provider_ids = [];
			f.manifest.runtimes[runtime].providerMode = "unmanaged";
			f.prepare();
			applyConnectionProviderTransfers(f.input());
			expect(f.read()).toEqual(before);
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

	test(`${runtime}: rotation preserves user model edits; native route/auth conflicts are skipped without writes`, () => {
		const f = fixture(runtime);
		try {
			const original = recordValue(f.read()) ?? {};
			f.set(undefined);
			expect(() => f.prepare()).toThrow("must already exist");
			f.set({
				...original,
				...(runtime === "openclaw" ? { apiKey: "foreign-key" } : { key_cmd: "foreign-command" }),
			});
			expectNativeWins(f);
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
					expectNativeWins(f);
				}
			}
			f.set({
				...original,
				...(runtime === "openclaw"
					? { baseUrl: "https://changed.example/v1" }
					: { api: "https://changed.example/v1" }),
			});
			expectNativeWins(f);
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

test.each([id, `custom:${id}`])(
	"Hermes preserves the selected connection's key_env mirror: %s",
	(selected) => {
		const f = fixture("hermes", "custom");
		try {
			const config = f.input().hermesConfig;
			config.document.setIn(["model", "provider"], selected);
			config.document.setIn(["model", "key_env"], envName);
			const before = config.document.toJS();
			for (let tick = 0; tick < 3; tick++) {
				const plan = f.prepare();
				applyConnectionProviderTransfers(f.input());
				f.restoreOwnership(commitProviderTransfers({ hermes: plan.providers }).hermes);
				expect(config.document.toJS()).toEqual(before);
			}
			for (const [field, value] of [
				["key_env", "FOREIGN_API_KEY"],
				["api_key", "inline-test-key"],
				["api", "foreign-auth"],
				["auth_mode", "oauth"],
			]) {
				config.document.setIn(["model", field], value);
				const conflicting = config.document.toString();
				expectNativeWins(f);
				expect(config.document.toString()).toBe(conflicting);
				config.document.deleteIn(["model", field]);
				config.document.setIn(["model", "key_env"], envName);
			}
			f.prepare();
			config.document.setIn(["model", "key_env"], "RACING_API_KEY");
			expect(() => applyConnectionProviderTransfers(f.input())).toThrow("changed after preflight");
		} finally {
			f.cleanup();
		}
	},
);

test("Hermes public pool conflict skips the connection without ownership or config mutation", () => {
	const f = fixture("hermes");
	try {
		writeFileSync(join(f.home, ".hermes/pool-conflict"), "present");
		expectNativeWins(f, "native_credential_pool_conflict");
		expect(f.input().ownership.providers).toEqual({});
		rmSync(join(f.home, ".hermes/pool-conflict"));
		expect(f.prepare().conflicts).toEqual({});
		// A native pool row that appears after preflight still blocks the config write.
		writeFileSync(join(f.home, ".hermes/pool-conflict"), "present");
		const before = f.read();
		expect(() => applyConnectionProviderTransfers(f.input())).toThrow(
			"pool changed after preflight",
		);
		expect(f.read()).toEqual(before);
	} finally {
		f.cleanup();
	}
});

test("Hermes pool conflict skips only its connection; the native selection is preserved", () => {
	const f = fixture("hermes", "custom");
	try {
		const app = join(f.home, ".hermes/hermes-agent");
		// The user's native custom_providers entry shares banban's base URL.
		writeFileSync(
			join(app, "agent/credential_pool.py"),
			"def custom_provider_pool_key_candidates(base_url, provider_name=None):\n    return ['custom:shared.example'] if 'shared' in base_url else [provider_name]\n",
		);
		writeFileSync(
			join(app, "hermes_cli/auth.py"),
			"def read_credential_pool(key):\n    return [{'source': 'model_config'}] if key == 'custom:shared.example' else []\n",
		);
		const binding = f.manifest.runtimes.hermes;
		const providers = f.manifest.projection?.providers;
		const saved = providers?.[id];
		if (!binding || !providers || !saved) throw new Error("Missing fixture");
		binding.provider_ids = [id, "banban"];
		providers.banban = {
			...saved,
			baseUrl: "https://shared.example/v1",
			runtimeEnvName: "CLAWDI_PROVIDER_BANBAN_API_KEY",
			apiKeySecretRef: "secret://provider.banban.apiKey",
		};
		f.secretValues["secret://provider.banban.apiKey"] = "banban-test-key";
		const config = f.input().hermesConfig;
		config.document.setIn(["model", "provider"], "custom:banban");
		const model = getHermesRawConfigValue(config, "model").value;
		const plan = f.prepare();
		expect(plan.conflicts).toEqual({ banban: "native_credential_pool_conflict" });
		expect(Object.keys(plan.providers)).toEqual([id]);
		expect(Object.keys(plan.patch)).toEqual([id]);
		applyConnectionProviderTransfers(f.input());
		expect(recordValue(f.read())?.key_env).toBe(envName);
		expect(getHermesRawConfigValue(config, "providers.banban").exists).toBe(false);
		expect(getHermesRawConfigValue(config, "model").value).toEqual(model);
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
				expect(f.prepare().conflicts).toEqual({ [id]: "native_credential_pool_conflict" });
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

for (const legacyAlias of [false, true]) {
	test(`Unset legacy Hermes preserves divergent native key and selected-model auth (legacy alias ${legacyAlias})`, () => {
		const f = fixture("hermes", "custom");
		try {
			const config = f.input().hermesConfig;
			if (!config) throw new Error("Missing Hermes fixture");
			const provider = {
				api: baseUrl,
				transport: "chat_completions",
				key_env: "HERMES_CUSTOM_X_API_API_KEY",
				...(legacyAlias ? { api_key_env: "X_API_KEY" } : {}),
				models: { saved: { context_length: 8192 } },
			};
			config.document.set("providers", { "x-api": provider });
			const model = {
				provider: "custom:x-api",
				default: "saved",
				key_env: "HERMES_CUSTOM_X_API_API_KEY",
				api_key: "synthetic-selected-model-key",
				api: "https://model.example",
				auth_mode: "api_key",
				api_mode: "openai_chat",
				base_url: baseUrl,
			};
			config.document.set("model", model);
			const envPath = join(f.home, ".hermes", ".env");
			writeFileSync(envPath, "HERMES_CUSTOM_X_API_API_KEY=preserved-native-key\n", { mode: 0o600 });
			f.restoreOwnership({ "x-api": { envName: "X_API_KEY", baseUrl, apiMode: "openai_chat" } });
			f.manifest.runtimes.hermes.provider_ids = [];
			f.manifest.runtimes.hermes.providerMode = "unmanaged";
			const before = config.document.toString();
			const plan = f.prepare();
			expect(plan.patch).toEqual(legacyAlias ? { "x-api": { api_key_env: null } } : {});
			applyProjector(f, ["x-api"]);
			expect(getHermesRawConfigValue(config, "model").value).toEqual(model);
			expect(getHermesRawConfigValue(config, "providers").value).toEqual({
				"x-api": {
					api: baseUrl,
					transport: "chat_completions",
					key_env: "HERMES_CUSTOM_X_API_API_KEY",
					models: provider.models,
				},
			});
			if (!legacyAlias) expect(config.document.toString()).toBe(before);
			expect(readFileSync(envPath, "utf8")).toBe(
				"HERMES_CUSTOM_X_API_API_KEY=preserved-native-key\n",
			);
		} finally {
			f.cleanup();
		}
	});
}
