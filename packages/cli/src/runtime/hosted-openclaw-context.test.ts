import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenClawHostedContext } from "./hosted-openclaw-context";
import { manifestSchema, type RuntimeManifest } from "./manifest-contract";

const roots: string[] = [];
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;

afterEach(() => {
	if (originalStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
	else process.env.OPENCLAW_STATE_DIR = originalStateDir;
	if (originalConfigPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
	else process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hostedOpenClawManifest(): RuntimeManifest {
	const providerId = "clawdi-v2-deployment-42";
	return manifestSchema.parse({
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "dep_openclaw_context",
		environmentId: "env_openclaw_context",
		instanceId: "iid_openclaw_context",
		generation: 1,
		issuedAt: "2026-08-20T00:00:00Z",
		controlPlane: { apiUrl: "https://cloud-api.example.test" },
		runtimes: {
			openclaw: {
				enabled: true,
				providerMode: "configured",
				provider_ids: [providerId],
				primary_model: { provider_id: providerId, model: "gpt-5.5" },
			},
		},
		projection: {
			sourceSchemaVersion: "clawdi.hosted-runtime.manifest.v1",
			sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
			providers: {
				[providerId]: {
					kind: "openai-compatible",
					baseUrl: "https://provider.example.test/v1",
					model: "gpt-5.5",
					models: [{ id: "gpt-5.5" }],
					apiMode: "openai_responses",
					managed_by: "clawdi",
					runtimeEnvName: "CLAWDI_AI_API_KEY",
					apiKeySecretRef: `secret://provider.${providerId}.apiKey`,
				},
			},
		},
		recovery: {},
	});
}

describe("hosted OpenClaw context", () => {
	test("pins hosted paths and evaluates the managed projection once", () => {
		const home = "/home/clawdi";
		process.env.OPENCLAW_STATE_DIR = "/tmp/untrusted-openclaw-state";
		process.env.OPENCLAW_CONFIG_PATH = "/tmp/untrusted-openclaw-config.json";
		const manifest = hostedOpenClawManifest();
		const context = createOpenClawHostedContext(manifest, home);

		expect(context.stateRoot).toBe(join(home, ".openclaw"));
		expect(context.configPath).toBe(join(home, ".openclaw", "openclaw.json"));
		expect(context.ownership).toEqual([
			{ path: home, owner: "runtime-user", kind: "directory", recursive: false },
			{
				path: join(home, ".openclaw"),
				owner: "runtime-user",
				kind: "directory",
				mode: 0o700,
				recursive: false,
			},
			{
				path: join(home, ".openclaw", "tmp"),
				owner: "runtime-user",
				kind: "directory",
				mode: 0o700,
				recursive: false,
			},
		]);
		expect(context.agentDirs).toEqual({
			root: join(home, ".openclaw", "agents"),
			main: join(home, ".openclaw", "agents", "main", "agent"),
			managed: [],
		});
		expect(context.managedApiKeyProjection).toBe(true);

		manifest.runtimes.openclaw.enabled = false;
		expect(context.managedApiKeyProjection).toBe(true);
		expect(createOpenClawHostedContext(manifest, home).managedApiKeyProjection).toBe(false);
	});

	test("resolves every public SDK entry through the canonical candidates", () => {
		const home = mkdtempSync(join(tmpdir(), "clawdi-openclaw-context-"));
		roots.push(home);
		const packageRoot = join(home, ".openclaw", "node_modules", "openclaw");
		mkdirSync(packageRoot, { recursive: true });
		const entries = {
			"config-mutation": "config-mutation.mjs",
			"device-bootstrap": "device-bootstrap.mjs",
			"provider-auth": "provider-auth.mjs",
			"provider-env-vars": "provider-env-vars.mjs",
		} as const;
		const entryNames = [
			"config-mutation",
			"device-bootstrap",
			"provider-auth",
			"provider-env-vars",
		] as const;
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "openclaw",
				type: "module",
				exports: Object.fromEntries(
					entryNames.map((name) => [`./plugin-sdk/${name}`, `./${entries[name]}`]),
				),
			}),
		);
		for (const path of Object.values(entries))
			writeFileSync(join(packageRoot, path), "export {};\n");

		const context = createOpenClawHostedContext(hostedOpenClawManifest(), home);
		for (const name of entryNames) {
			expect(context.resolveSdkExport(name, {})).toBe(join(packageRoot, entries[name]));
		}
	});
});
