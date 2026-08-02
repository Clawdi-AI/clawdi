import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeChannelsLoad, RuntimeManifestLoad } from "../src/runtime/manifest-source";

mock.module(join(import.meta.dir, "../src/runtime/whatsapp-gate.ts"), () => ({
	WHATSAPP_LINKING_READY: true,
	WHATSAPP_RUNTIME_READY: true,
	WHATSAPP_UPSTREAM_READY: true,
}));

const { applyRuntimeChannelsToManifestLoad } = await import("../src/runtime/channels");
const { materializeHostedChannelCredentials, runtimeUserMutationTargets } = await import(
	"../src/runtime/manifest"
);
const { getRuntimePaths } = await import("../src/runtime/paths");
const { CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER } = await import(
	"../src/runtime/whatsapp-upstream-contract"
);

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each(["openclaw", "hermes"] as const)("managed WhatsApp %s projection", (runtime) => {
	it("projects stock auth plus a per-Link upgrade capability without URL or bearer leakage", () => {
		const home = temporaryHome();
		const load = runtimeLoad(runtime, home);
		const channels = whatsappChannels();

		const projected = applyRuntimeChannelsToManifestLoad(load, channels);
		const credentials = projected.manifest.projection?.channelCredentials;
		expect(credentials).toHaveLength(1);
		const credential = credentials?.[0] as Record<string, unknown>;
		const targets = credential.targets as Record<string, { authDir: string }>;
		const authDir = targets[runtime]?.authDir;
		expect(authDir).toBe(
			runtime === "openclaw"
				? join(home, ".openclaw", "credentials", "whatsapp", "clawdi_acctwhatsapp")
				: join(home, ".hermes", "platforms", "whatsapp", "session"),
		);
		const files = credential.files as Array<{ path: string; secretRef: string }>;
		expect(files.map((file) => file.path)).toEqual(["creds.json"]);
		const credsSecretRef = files[0]?.secretRef;
		if (!credsSecretRef) throw new Error("missing creds secret ref");
		const credsJson = projected.secretValues?.[credsSecretRef];
		if (!credsJson) throw new Error("missing creds material");
		const creds = JSON.parse(credsJson) as Record<string, unknown>;
		const metadata = managedMetadata(projected);
		expect(metadata).toEqual({
			schemaVersion: "clawdi.managedWhatsAppSocket.v1",
			capability: expect.stringMatching(/^clawdi_[a-f0-9]{32}$/),
			authCert: whatsappAuthCert(),
		});
		expect(creds.additionalData).toMatchObject({ existing: "preserved" });
		expect(JSON.stringify(creds)).not.toContain("wa-agent-link-bearer");
		expect(JSON.stringify(creds)).not.toContain("websocketUrl");
		expect(credsSecretRef).toContain("/credentials/credential-whatsapp-1/creds-json");

		const profiles = projected.manifest.egressProfiles?.profiles ?? [];
		const managed = profiles.find((profile) => profile.kind === "websocket");
		const deny = profiles.find((profile) => profile.kind === "deny");
		expect(managed).toMatchObject({
			match: {
				scheme: "wss",
				host: "web.whatsapp.com",
				path: { type: "equals", value: "/ws/chat" },
				headers: {
					[CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER]: {
						type: "secretRefEquals",
						secretRef:
							"secret://channels/whatsapp/clawdi_acctwhatsapp/links/link-whatsapp-1/egress-capability",
					},
				},
			},
			rewrite: {
				upstreamBaseUrl: "wss://cloud-api.test/v1/channels/whatsapp/baileys",
				preservePath: false,
				removeHeaders: [CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER],
				setHeaders: {
					authorization: {
						type: "secretRef",
						secretRef:
							"secret://channels/whatsapp/clawdi_acctwhatsapp/links/link-whatsapp-1/agent-token",
						prefix: "Bearer ",
					},
				},
			},
		});
		expect(managed?.match).not.toHaveProperty("notAfter");
		expect(deny).toMatchObject({
			kind: "deny",
			match: {
				headers: {
					[CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER]: { type: "exists" },
				},
			},
		});
		expect(managed?.match.headers).not.toHaveProperty("authorization");

		materializeHostedChannelCredentials(projected.manifest, projected.secretValues, home);
		if (!authDir) throw new Error("missing auth dir");
		const materializedCreds = readFileSync(join(authDir, "creds.json"), "utf8");
		expect(materializedCreds).not.toContain("wa-agent-link-bearer");
		expect(materializedCreds).not.toContain("websocketUrl");
		expect(existsSync(join(authDir, ".clawdi-managed-whatsapp-socket.json"))).toBe(false);
		expect(JSON.parse(materializedCreds)).toEqual({
			advSecretKey: "synthetic-auth-only",
			me: { id: "15551234567:1@s.whatsapp.net" },
			additionalData: {
				existing: "preserved",
				"clawdi.managedWhatsAppSocket": metadata,
			},
		});
	});
});

it("uses Link identity in the marker and refuses cross-Link reuse", () => {
	const home = temporaryHome();
	const first = applyRuntimeChannelsToManifestLoad(
		runtimeLoad("openclaw", home),
		whatsappChannels(),
	);
	const second = applyRuntimeChannelsToManifestLoad(
		runtimeLoad("openclaw", home),
		whatsappChannels("link-whatsapp-2"),
	);
	const repeated = applyRuntimeChannelsToManifestLoad(
		runtimeLoad("openclaw", home),
		whatsappChannels(),
	);
	const firstMetadata = managedMetadata(first);
	const secondMetadata = managedMetadata(second);
	expect(firstMetadata.capability).not.toBe(secondMetadata.capability);
	expect(managedMetadata(repeated).capability).toBe(firstMetadata.capability);
	const firstProfile = first.manifest.egressProfiles?.profiles.find(
		(profile) => profile.kind === "websocket",
	);
	const secondProfile = second.manifest.egressProfiles?.profiles.find(
		(profile) => profile.kind === "websocket",
	);
	expect(firstProfile?.match.headers[CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER]).not.toEqual(
		secondProfile?.match.headers[CLAWDI_WHATSAPP_LINK_CAPABILITY_HEADER],
	);
	expect(firstProfile?.match).not.toHaveProperty("notAfter");
});

it("refuses malformed synthetic additionalData before projecting secrets", () => {
	const home = temporaryHome();
	const channels = whatsappChannels();
	const credential = channels.channels[0]?.runtime_credentials?.[0];
	if (!credential || typeof credential.material !== "object" || !credential.material) {
		throw new Error("missing WhatsApp credential fixture");
	}
	const creds = Reflect.get(credential.material, "creds");
	if (!creds || typeof creds !== "object") throw new Error("missing synthetic creds fixture");
	Reflect.set(creds, "additionalData", "malformed");

	expect(() => applyRuntimeChannelsToManifestLoad(runtimeLoad("openclaw", home), channels)).toThrow(
		"synthetic creds.additionalData must be an object",
	);
});

it("refuses tampered namespaced metadata before auth materialization", () => {
	const home = temporaryHome();
	const projected = applyRuntimeChannelsToManifestLoad(
		runtimeLoad("openclaw", home),
		whatsappChannels(),
	);
	const credential = projected.manifest.projection?.channelCredentials?.[0] as Record<
		string,
		unknown
	>;
	const files = credential.files as Array<{ path: string; secretRef: string }>;
	const credsRef = files.find((file) => file.path === "creds.json")?.secretRef;
	if (!credsRef || !projected.secretValues?.[credsRef]) {
		throw new Error("missing projected creds fixture");
	}
	const creds = JSON.parse(projected.secretValues[credsRef]) as Record<string, unknown>;
	const additionalData = creds.additionalData as Record<string, unknown>;
	const metadata = additionalData["clawdi.managedWhatsAppSocket"] as Record<string, unknown>;
	metadata.extra = true;
	projected.secretValues[credsRef] = JSON.stringify(creds);

	expect(() =>
		materializeHostedChannelCredentials(projected.manifest, projected.secretValues, home),
	).toThrow("invalid managed WhatsApp metadata");
	expect(
		existsSync(join(home, ".openclaw", "credentials", "whatsapp", "clawdi_acctwhatsapp")),
	).toBe(false);
});

it("removes only CLI-owned managed auth when no Link remains", () => {
	const home = temporaryHome();
	const projected = applyRuntimeChannelsToManifestLoad(
		runtimeLoad("openclaw", home),
		whatsappChannels(),
	);
	materializeHostedChannelCredentials(projected.manifest, projected.secretValues, home);
	const authDir = join(home, ".openclaw", "credentials", "whatsapp", "clawdi_acctwhatsapp");
	expect(existsSync(authDir)).toBe(true);
	const paths = {
		...getRuntimePaths(),
		userHome: home,
		installInventory: join(home, ".clawdi-test", "install-inventory"),
		localEnvironments: join(home, ".clawdi-test", "environments"),
	};
	expect(
		runtimeUserMutationTargets(
			runtimeLoad("openclaw", home).manifest,
			paths,
			home,
			new Map([["openclaw", { status: "present" as const }]]),
		),
	).toContain(authDir);

	const emptyLoad = runtimeLoad("openclaw", home);
	emptyLoad.manifest = projected.manifest;
	const empty = applyRuntimeChannelsToManifestLoad(emptyLoad, {
		channels: [],
		source: "remote-datasource",
		sourcePath: "test://channels/empty",
	});
	materializeHostedChannelCredentials(empty.manifest, empty.secretValues, home);
	expect(existsSync(authDir)).toBe(false);
	expect(empty.manifest.egressProfiles?.profiles).toEqual([
		expect.objectContaining({
			id: "native-whatsapp-baileys-invalid-capability",
			kind: "deny",
		}),
	]);
});

it("uses broad installer and plugin snapshots instead of overlapping patch targets", () => {
	const home = temporaryHome();
	const projected = applyRuntimeChannelsToManifestLoad(
		runtimeLoad("hermes", home),
		whatsappChannels(),
	);
	const hermes = projected.manifest.runtimes.hermes;
	if (!hermes) throw new Error("missing Hermes runtime");
	hermes.install = {
		authority: "official",
		method: "official-installer",
		url: "https://hermes-agent.nousresearch.com/install.sh",
		home,
		args: [],
	};
	const appRoot = join(home, ".hermes", "hermes-agent");
	const paths = {
		...getRuntimePaths(),
		userHome: home,
		installInventory: join(home, ".clawdi-test", "install-inventory"),
		localEnvironments: join(home, ".clawdi-test", "environments"),
	};
	const targets = runtimeUserMutationTargets(
		projected.manifest,
		paths,
		home,
		new Map([["hermes", { status: "configured" as const }]]),
	);

	expect(targets).toContain(appRoot);
	expect(targets.some((target) => target.startsWith(`${appRoot}/`))).toBe(false);

	const openclaw = applyRuntimeChannelsToManifestLoad(
		runtimeLoad("openclaw", home),
		whatsappChannels(),
	);
	const pluginRoot = join(home, ".openclaw", "extensions", "whatsapp");
	const openclawTargets = runtimeUserMutationTargets(
		openclaw.manifest,
		paths,
		home,
		new Map([["openclaw", { status: "present" as const }]]),
	);
	expect(openclawTargets).toContain(pluginRoot);
	expect(openclawTargets.some((target) => target.startsWith(`${pluginRoot}/`))).toBe(false);
});

function temporaryHome(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-managed-whatsapp-projection-"));
	roots.push(root);
	return join(root, "home");
}

function runtimeLoad(runtime: "openclaw" | "hermes", home: string): RuntimeManifestLoad {
	return {
		manifest: {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			runtime,
			deploymentId: "dep-managed-whatsapp",
			environmentId: "env-managed-whatsapp",
			instanceId: "instance-managed-whatsapp",
			generation: 1,
			issuedAt: "2026-08-02T00:00:00Z",
			controlPlane: { apiUrl: "https://cloud-api.test" },
			runtimes: { [runtime]: { enabled: true } },
			projection: { system: { home, workspace: home } },
		},
		source: "remote-datasource",
		sourcePath: "test://manifest",
		offline: false,
		secretValues: {},
	};
}

function whatsappChannels(linkId = "link-whatsapp-1"): RuntimeChannelsLoad {
	return {
		channels: [
			{
				id: "acct-whatsapp",
				provider: "whatsapp",
				name: "Managed WhatsApp",
				status: "active",
				visibility: "private",
				runtime_links: [
					{
						id: linkId,
						account_id: "acct-whatsapp",
						agent_id: "env-managed-whatsapp",
						status: "active",
						agent_token: "wa-agent-link-bearer",
					},
				],
				runtime_credentials: [
					{
						id: "credential-whatsapp-1",
						account_id: "acct-whatsapp",
						agent_link_id: linkId,
						agent_id: "env-managed-whatsapp",
						provider: "whatsapp",
						kind: "whatsapp_baileys_auth_state",
						material: {
							schemaVersion: "clawdi.whatsappBaileysAuthState.v1",
							creds: {
								advSecretKey: "synthetic-auth-only",
								me: { id: "15551234567:1@s.whatsapp.net" },
								additionalData: { existing: "preserved" },
							},
							websocketUrl: "wss://backend.invalid/must-not-project",
							authCert: whatsappAuthCert(),
						},
					},
				],
			},
		],
		source: "remote-datasource",
		sourcePath: "test://channels",
	};
}

function whatsappAuthCert() {
	return {
		SERIAL: 7,
		ISSUER: "clawdi",
		PUBLIC_KEY: { type: "Buffer", data: Buffer.alloc(32, 7).toString("base64") },
	};
}

function managedMetadata(load: RuntimeManifestLoad): Record<string, unknown> {
	const credential = load.manifest.projection?.channelCredentials?.[0] as Record<string, unknown>;
	const files = credential.files as Array<{ path: string; secretRef: string }>;
	const ref = files.find((file) => file.path === "creds.json")?.secretRef;
	if (!ref) throw new Error("missing creds ref");
	const value = load.secretValues?.[ref];
	if (!value) throw new Error("missing creds value");
	const creds = JSON.parse(value) as Record<string, unknown>;
	const additionalData = creds.additionalData as Record<string, unknown>;
	return additionalData["clawdi.managedWhatsAppSocket"] as Record<string, unknown>;
}
