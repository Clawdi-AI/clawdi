import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeManifestLoad } from "../../../src/runtime/manifest-source";

const { applyRuntimeBundleChannelsToManifestLoad } = await import("../../../src/runtime/channels");
const { buildEgressProfileBundle, egressProfileSecretRefs } = await import(
	"../../../src/runtime/egress-profiles"
);
const { reconcileManagedBaileysCompatibility } = await import(
	"../../../src/runtime/managed-baileys-compat"
);
const { materializeHostedChannelCredentials } = await import("../../../src/runtime/manifest");

test("projects and reconciles the real managed WhatsApp runtime", () => {
	const runtime = requiredRuntime();
	const home = requiredEnvironment("E2E_HOME");
	const scenarioPath = requiredEnvironment("E2E_SCENARIO");
	const outputRoot = requiredEnvironment("E2E_OUTPUT");
	process.env.CLAWDI_RUNTIME_HOME = home;
	process.env.CLAWDI_SERVICE_STATE_DIR = join(outputRoot, "platform-state");
	mkdirSync(process.env.CLAWDI_SERVICE_STATE_DIR, { recursive: true });
	const scenario = recordValue(JSON.parse(readFileSync(scenarioPath, "utf8")));
	const channelMaterial = z
		.object({
			creds: z.record(z.string(), z.unknown()),
			authCert: z
				.object({
					SERIAL: z.number().int().nonnegative(),
					ISSUER: z.string().min(1),
					PUBLIC_KEY: z.object({ type: z.literal("Buffer"), data: z.string().min(1) }).strict(),
				})
				.strict(),
		})
		.passthrough()
		.parse(scenario.channelMaterial);

	const accountId = "50000000-0000-4000-8000-000000000005";
	const accountKey = "clawdi_50000000000040008000000000000005";
	const linkId = "60000000-0000-4000-8000-000000000006";
	const credentialId = "80000000-0000-4000-8000-000000000011";
	const agentTokenSecretRef = `secret://channels/whatsapp/${accountKey}/links/${linkId}/agent-token`;
	const capabilitySecretRef = `secret://channels/whatsapp/${accountKey}/links/${linkId}/egress-capability`;
	const credentialSecretRef = `secret://channels/whatsapp/${accountKey}/credentials/${credentialId}/creds-json`;
	const capability = `clawdi_${"0".repeat(32)}`;
	const manifest: RuntimeManifestLoad = {
		...runtimeManifest(runtime, home),
		channelBindings: [
			{
				provider: "whatsapp",
				accountId,
				accountKey,
				linkId,
				agentTokenSecretRef,
				placeholderTokenSecretRef: capabilitySecretRef,
				credential: {
					id: credentialId,
					credsSecretRef: credentialSecretRef,
					authCert: channelMaterial.authCert,
				},
			},
		],
		secretValues: {
			[agentTokenSecretRef]: "wa-native-e2e-link-bearer",
			[capabilitySecretRef]: capability,
			[credentialSecretRef]: JSON.stringify(channelMaterial.creds),
		},
	};

	const projected = applyRuntimeBundleChannelsToManifestLoad(manifest);
	materializeHostedChannelCredentials(projected.manifest, projected.secretValues, home);
	const credential = projected.manifest.projection?.channelCredentials?.[0];
	if (!credential) throw new Error("managed WhatsApp credential was not projected");
	const target = credential.targets[runtime];
	if (!target) throw new Error(`managed WhatsApp ${runtime} auth target was not projected`);
	const authDir = target.authDir;
	const credsPath = join(authDir, "creds.json");
	expect(existsSync(credsPath)).toBe(true);
	const credsText = readFileSync(credsPath, "utf8");
	expect(credsText).not.toContain("wa-native-e2e-link-bearer");
	expect(credsText).not.toContain("must-not-project.invalid");
	expect(credsText).toContain("clawdi.managedWhatsAppSocket");

	const appRoot =
		runtime === "openclaw" ? join(home, ".openclaw") : join(home, ".hermes", "hermes-agent");
	const compatibility = reconcileManagedBaileysCompatibility({
		desiredRuntime: runtime,
		home,
		appRoot,
	});
	expect(["applied", "already-patched"]).toContain(compatibility.status);

	const egressInput = projected.manifest.egressProfiles;
	if (!egressInput) throw new Error("managed WhatsApp egress profiles were not projected");
	const egressBundle = buildEgressProfileBundle({
		generatedAt: "2026-08-03T00:00:00Z",
		generation: 1,
		instanceId: `native-e2e-${runtime}`,
		profiles: egressInput,
	});
	const secretValues = projected.secretValues ?? {};
	const egressSecrets = Object.fromEntries(
		egressProfileSecretRefs(egressInput).map((ref) => {
			const value = secretValues[ref];
			if (!value) throw new Error(`managed WhatsApp egress secret is missing: ${ref}`);
			return [ref, value];
		}),
	);
	expect(egressSecrets).not.toHaveProperty(capabilitySecretRef);
	mkdirSync(outputRoot, { recursive: true });
	const profileBundlePath = join(outputRoot, "egress-profiles.json");
	const secretFilePath = join(outputRoot, "egress-secrets.json");
	writeFileSync(profileBundlePath, `${JSON.stringify(egressBundle, null, 2)}\n`, { mode: 0o600 });
	writeFileSync(secretFilePath, `${JSON.stringify(egressSecrets, null, 2)}\n`, { mode: 0o600 });
	const projectedChannels = projected.manifest.projection?.channels ?? {};
	let openClawConfigPatchPath: string | undefined;
	if (runtime === "openclaw") {
		openClawConfigPatchPath = join(outputRoot, "openclaw-config-patch.json");
		writeFileSync(
			openClawConfigPatchPath,
			`${JSON.stringify(openClawConfigPatch(home, projectedChannels), null, 2)}\n`,
			{ mode: 0o600 },
		);
	}
	writeFileSync(
		join(outputRoot, "projection.json"),
		`${JSON.stringify(
			{
				runtime,
				home,
				authDir,
				appRoot,
				profileBundlePath,
				secretFilePath,
				channels: projectedChannels,
				openClawConfigPatchPath,
				run: projected.manifest.runtimes[runtime]?.run ?? {},
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
});

function openClawConfigPatch(home: string, channels: Record<string, unknown>) {
	return {
		gateway: {
			mode: "local",
			bind: "loopback",
			port: 18789,
			auth: { mode: "token", token: "native-e2e-gateway-token" },
		},
		agents: {
			defaults: {
				workspace: join(home, "workspace"),
				model: { primary: "native/native-e2e" },
				models: { "native/native-e2e": { alias: "Native E2E" } },
			},
		},
		models: {
			mode: "replace",
			providers: {
				native: {
					baseUrl: "http://127.0.0.1:9000/v1",
					apiKey: "native-e2e-model-key",
					api: "openai-completions",
					models: [
						{
							id: "native-e2e",
							name: "Native E2E",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 32_768,
							maxTokens: 256,
							compat: { requiresStringContent: true, strictMessageKeys: true },
						},
					],
				},
			},
		},
		session: { dmScope: "per-account-channel-peer" },
		channels,
	};
}

function runtimeManifest(runtime: "openclaw" | "hermes", home: string): RuntimeManifestLoad {
	const runtimes =
		runtime === "openclaw" ? { openclaw: { enabled: true } } : { hermes: { enabled: true } };
	return {
		manifest: {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			runtime,
			deploymentId: "native-e2e",
			environmentId: "agent-native-e2e",
			instanceId: `native-e2e-${runtime}`,
			generation: 1,
			issuedAt: "2026-08-03T00:00:00Z",
			controlPlane: { apiUrl: "http://127.0.0.1:9000" },
			runtimes,
			projection: { system: { home, workspace: home } },
		},
		source: "native-e2e",
		sourcePath: "test://native-e2e/manifest",
		offline: false,
		secretValues: {},
	};
}

function requiredRuntime(): "openclaw" | "hermes" {
	const runtime = requiredEnvironment("E2E_RUNTIME");
	if (runtime !== "openclaw" && runtime !== "hermes") {
		throw new Error("E2E_RUNTIME must be openclaw or hermes");
	}
	return runtime;
}

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function recordValue(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("native E2E scenario must be an object");
	}
	return value as Record<string, unknown>;
}
