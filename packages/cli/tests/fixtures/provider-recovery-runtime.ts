/** Native transfer process used by the paired Hosted controller regression. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
	applyConnectionProviderTransfers,
	prepareConnectionProviderTransfers,
} from "../../src/runtime/connection-provider-config";
import type { HermesConfigTransaction } from "../../src/runtime/hermes-config";
import { createOpenClawHostedContext } from "../../src/runtime/hosted-openclaw-context";
import { hostedProviderEnvironment } from "../../src/runtime/hosted-provider-resolution";
import type { RuntimeManifest } from "../../src/runtime/manifest-contract";
import { recordValue } from "../../src/runtime/manifest-shared";
import { getRuntimePaths } from "../../src/runtime/paths";
import {
	commitProviderTransfers,
	readProviderOwnership,
	writeProviderOwnership,
} from "../../src/runtime/provider-ownership";

const transfer = z.object({
	envName: z.string(),
	baseUrl: z.string(),
	apiMode: z.literal("openai_chat"),
});
const request = z
	.object({
		home: z.string(),
		instanceId: z.string(),
		generation: z.number().int().positive(),
		selected: z.array(z.string()),
		connections: z.record(z.string(), transfer),
		initialTransfers: z.record(z.string(), transfer),
		initialConfig: z.record(z.string(), z.unknown()),
		modelPatch: z.record(z.string(), z.unknown()).optional(),
	})
	.parse(JSON.parse(readFileSync(0, "utf8")));
const { home, instanceId, generation } = request;
const configPath = join(home, ".hermes/config.yaml");
const app = join(home, ".hermes/hermes-agent");
const paths = { ...getRuntimePaths(), serviceStateRoot: join(home, "service") };
for (const dir of [
	paths.serviceStateRoot,
	join(app, "agent"),
	join(app, "hermes_cli"),
	join(app, "venv/bin"),
])
	mkdirSync(dir, { recursive: true });
if (!existsSync(configPath)) {
	writeFileSync(configPath, JSON.stringify(request.initialConfig));
	// Public credential-pool API double. Transfer validation and journal/config writes
	// below execute the production CLI implementation in a separate process.
	writeFileSync(
		join(app, "agent/credential_pool.py"),
		"def custom_provider_pool_key_candidates(base_url, provider_name=None):\n    return [provider_name]\n",
	);
	writeFileSync(join(app, "hermes_cli/auth.py"), "def read_credential_pool(key):\n    return []\n");
	symlinkSync("/usr/bin/python3", join(app, "venv/bin/python"));
	writeProviderOwnership(paths, instanceId, home, {
		providers: { openclaw: [], hermes: [] },
		transfers: { openclaw: {}, hermes: request.initialTransfers },
	});
}
const document = parseDocument(readFileSync(configPath, "utf8"));
for (const [field, value] of Object.entries(request.modelPatch ?? {})) {
	if (value === null) document.deleteIn(["model", field]);
	else document.setIn(["model", field], value);
}
writeFileSync(configPath, document.toString());
const manifest: RuntimeManifest = {
	schemaVersion: "clawdi.runtimeDesiredState.v1",
	deploymentId: "provider-regression",
	environmentId: "provider-regression",
	instanceId,
	generation,
	issuedAt: "2026-09-11T00:00:00Z",
	runtime: "hermes",
	controlPlane: { apiUrl: "https://cloud.example.test" },
	recovery: {},
	runtimes: {
		hermes: {
			enabled: true,
			providerMode: "configured",
			provider_ids: request.selected,
			primary_model: null,
			services: {},
		},
	},
	projection: {
		providers: Object.fromEntries(
			Object.entries(request.connections).map(([id, row]) => [
				id,
				{
					kind: "openai-compatible",
					type: "custom_openai_compatible",
					configurationMode: "custom",
					managed_by: "user",
					baseUrl: row.baseUrl,
					apiMode: row.apiMode,
					runtimeEnvName: row.envName,
					apiKeySecretRef: `secret://provider.${id}.apiKey`,
				},
			]),
		),
	},
};
const appliedPath = join(paths.serviceStateRoot, "fixture-applied.json");
let applied: string[] = existsSync(appliedPath)
	? z.array(z.string()).parse(JSON.parse(readFileSync(appliedPath, "utf8")))
	: [];
const ownership = readProviderOwnership(paths, instanceId, home, { hermes: applied });
const hermesConfig: HermesConfigTransaction = {
	context: { command: "/usr/bin/python3", home, cwd: home },
	path: configPath,
	sourceContent: document.toString(),
	document,
	changed: false,
};
const input = {
	runtime: "hermes",
	manifest,
	home,
	workspaceRoot: home,
	openClawContext: createOpenClawHostedContext(manifest, home),
	hermesConfig,
	secretValues: Object.fromEntries(
		Object.keys(request.connections).map((id) => [
			`secret://provider.${id}.apiKey`,
			"synthetic-test-key",
		]),
	),
	observation: {
		runtime: "hermes",
		enabled: true,
		status: "present" as const,
		commandPath: "/usr/bin/python3",
		executionUser: null,
		appRoot: null,
		install: null,
		installerUrl: null,
		executedInstallerUrl: null,
		exitCode: null,
		error: null,
	},
	ownership: { providers: ownership.transfers.hermes ?? {} },
};
let error: string | null = null;
try {
	const prepared = prepareConnectionProviderTransfers(input);
	ownership.transfers.hermes = prepared.providers;
	writeProviderOwnership(paths, instanceId, home, ownership);
	applyConnectionProviderTransfers({
		...input,
		ownership: { providers: prepared.providers, prepared },
	});
	writeFileSync(configPath, document.toString());
	ownership.transfers = commitProviderTransfers(ownership.transfers);
	writeProviderOwnership(paths, instanceId, home, ownership);
	applied = request.selected;
	writeFileSync(appliedPath, JSON.stringify(applied));
} catch (cause) {
	error = cause instanceof Error ? cause.message : "Native transfer failed";
}
const config = recordValue(document.toJS()) ?? {};
const model = recordValue(config.model) ?? {};
const providers = recordValue(config.providers) ?? {};
const selectedModel =
	typeof model.provider === "string" ? model.provider.replace(/^custom:/, "") : "";
const native = recordValue(providers[selectedModel]);
const modelEnv = model.key_env ?? native?.key_env ?? native?.api_key_env;
const injected = hostedProviderEnvironment(manifest, "hermes").secretEnv;
process.stdout.write(
	JSON.stringify({
		error,
		applied,
		modelProvider: model.provider,
		modelDefault: model.default,
		modelCredentialAvailable: typeof modelEnv === "string" && Object.hasOwn(injected, modelEnv),
		userDataDigest: createHash("sha256")
			.update(
				JSON.stringify({
					default: model.default,
					userData: config.userData,
					models: Object.fromEntries(
						Object.entries(providers).map(([id, row]) => [id, recordValue(row)?.models]),
					),
				}),
			)
			.digest("hex"),
	}),
);
