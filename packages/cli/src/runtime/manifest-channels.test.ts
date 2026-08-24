import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	chownSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	materializeHostedChannelCredentials,
	validateHostedChannelCredentialsPlan,
} from "./manifest-channels";
import type { RuntimeManifest } from "./manifest-contract";
import { withRuntimeUserFileAccess } from "./runtime-user-command";

const LEGACY_MARKER = ".clawdi-managed-whatsapp-auth.json";
const ACCOUNT_KEY = "clawdi_whatsapp_test";
const SECRET_REF = `secret://channels/whatsapp/${ACCOUNT_KEY}/credentials/credential-test/creds-json`;

let root: string;
let home: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clawdi-manifest-channels-"));
	home = join(root, "home", "clawdi");
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "var", "lib", "clawdi");
	mkdirSync(process.env.CLAWDI_SERVICE_STATE_DIR, { recursive: true });
});

afterEach(() => {
	delete process.env.CLAWDI_RUNTIME_MODE;
	delete process.env.CLAWDI_SERVICE_STATE_DIR;
	delete process.env.CLAWDI_RUNTIME_USER;
	delete process.env.CLAWDI_RUNTIME_UID;
	delete process.env.CLAWDI_RUNTIME_GID;
	rmSync(root, { recursive: true, force: true });
});

function authDir(name = ACCOUNT_KEY): string {
	return join(home, ".openclaw", "credentials", "whatsapp", name);
}

function manifest(path: string, credentialId = "credential-test"): RuntimeManifest {
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "dep_whatsapp_receipt_test",
		environmentId: "env_whatsapp_receipt_test",
		instanceId: "iid_whatsapp_receipt_test",
		generation: 1,
		issuedAt: "2026-08-21T00:00:00Z",
		controlPlane: { apiUrl: "https://cloud-api.test" },
		runtimes: {},
		projection: {
			system: { home, workspace: join(home, "clawdi") },
			channelCredentials: [
				{
					provider: "whatsapp",
					kind: "whatsapp_baileys_auth_state",
					accountKey: ACCOUNT_KEY,
					credentialId,
					files: [{ path: "creds.json", secretRef: SECRET_REF }],
					targets: { openclaw: { authDir: path } },
				},
			],
		},
		recovery: {},
	};
}

function credsJson(
	secret = "managed-secret",
	credentialId?: string,
	legacyCapability = false,
): string {
	return JSON.stringify({
		advSecretKey: secret,
		additionalData: {
			"clawdi.managedWhatsAppSocket": {
				schemaVersion: "clawdi.managedWhatsAppSocket.v1",
				...(legacyCapability ? { capability: `clawdi_${"a".repeat(32)}` } : {}),
				authCert: {
					SERIAL: 7,
					ISSUER: "clawdi",
					PUBLIC_KEY: {
						type: "Buffer",
						data: Buffer.alloc(32, 7).toString("base64"),
					},
				},
			},
			...(credentialId
				? {
						"clawdi.managedWhatsAppCredential": {
							schemaVersion: "clawdi.managedWhatsAppCredential.v1",
							credentialId,
						},
					}
				: {}),
		},
	});
}

function legacyMarker(credentialId = "credential-test"): string {
	return `${JSON.stringify({
		schemaVersion: "clawdi.managedWhatsAppAuth.v1",
		provider: "whatsapp",
		target: "legacy",
		accountKey: ACCOUNT_KEY,
		credentialId,
	})}\n`;
}

describe("managed WhatsApp auth directories", () => {
	test("materializes ownership in creds.json and removes stale managed auth", () => {
		const path = authDir();
		const desired = manifest(path);
		materializeHostedChannelCredentials(
			desired,
			{ [SECRET_REF]: credsJson("managed-secret", "credential-test") },
			home,
		);

		expect(readdirSync(path)).toEqual(["creds.json"]);
		expect(JSON.parse(readFileSync(join(path, "creds.json"), "utf8"))).toMatchObject({
			additionalData: {
				"clawdi.managedWhatsAppCredential": {
					schemaVersion: "clawdi.managedWhatsAppCredential.v1",
					credentialId: "credential-test",
				},
			},
		});

		materializeHostedChannelCredentials(
			{ ...desired, projection: { ...desired.projection, channelCredentials: [] } },
			{},
			home,
		);
		expect(existsSync(path)).toBe(false);
	});

	test("adopts 0.13.92 and 0.14.14 creds metadata without replacing sessions", () => {
		const path = authDir();
		mkdirSync(path, { recursive: true });
		const sessionPath = join(path, "session-key.json");
		writeFileSync(join(path, "creds.json"), `${credsJson("legacy-secret", undefined, true)}\n`);
		writeFileSync(sessionPath, '{"preserved":true}\n');
		writeFileSync(join(path, LEGACY_MARKER), legacyMarker("credential-old"));
		const sessionBefore = { bytes: readFileSync(sessionPath), inode: statSync(sessionPath).ino };
		const desired = manifest(path, "credential-new");

		validateHostedChannelCredentialsPlan(
			desired,
			{ [SECRET_REF]: credsJson("legacy-secret", "credential-new") },
			home,
		);
		expect(existsSync(join(path, LEGACY_MARKER))).toBe(true);

		materializeHostedChannelCredentials(
			desired,
			{ [SECRET_REF]: credsJson("legacy-secret", "credential-new") },
			home,
		);
		expect(existsSync(join(path, LEGACY_MARKER))).toBe(false);
		const rewrittenCreds = readFileSync(join(path, "creds.json"), "utf8");
		expect(rewrittenCreds).toContain("credential-new");
		expect(rewrittenCreds).not.toContain("capability");
		expect(readFileSync(sessionPath)).toEqual(sessionBefore.bytes);
		expect(statSync(sessionPath).ino).toBe(sessionBefore.inode);
	});

	test("rejects directories without valid creds metadata", () => {
		const cases = [
			JSON.stringify({ advSecretKey: "user-secret" }),
			JSON.stringify({
				additionalData: { "clawdi.managedWhatsAppSocket": {} },
			}),
			credsJson("user-secret", "credential-test").replace(
				"clawdi.managedWhatsAppCredential.v1",
				"invalid",
			),
		];
		for (const creds of cases) {
			const path = authDir();
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "creds.json"), `${creds}\n`);
			writeFileSync(join(path, LEGACY_MARKER), legacyMarker());

			expect(() =>
				materializeHostedChannelCredentials(
					manifest(path),
					{ [SECRET_REF]: credsJson("managed-secret", "credential-test") },
					home,
				),
			).toThrow(`refusing to overwrite unmanaged WhatsApp auth directory ${path}`);
			rmSync(path, { recursive: true, force: true });
		}
	});

	test("replaces session state when credential identity changes", () => {
		const path = authDir();
		materializeHostedChannelCredentials(
			manifest(path, "credential-one"),
			{ [SECRET_REF]: credsJson("first", "credential-one") },
			home,
		);
		writeFileSync(join(path, "session-key.json"), '{"stale":true}\n');

		materializeHostedChannelCredentials(
			manifest(path, "credential-two"),
			{ [SECRET_REF]: credsJson("second", "credential-two") },
			home,
		);

		expect(readdirSync(path)).toEqual(["creds.json"]);
		expect(readFileSync(join(path, "creds.json"), "utf8")).toContain("credential-two");
	});

	test("materializes auth as the runtime user", () => {
		if (process.getuid?.() !== 0) return;
		const runtimeId = 1_000;
		process.env.CLAWDI_RUNTIME_USER = String(runtimeId);
		process.env.CLAWDI_RUNTIME_UID = String(runtimeId);
		process.env.CLAWDI_RUNTIME_GID = String(runtimeId);
		mkdirSync(home, { recursive: true });
		chmodSync(root, 0o755);
		chownSync(join(root, "home"), runtimeId, runtimeId);
		chownSync(home, runtimeId, runtimeId);

		const path = authDir();
		withRuntimeUserFileAccess(() =>
			materializeHostedChannelCredentials(
				manifest(path),
				{ [SECRET_REF]: credsJson("managed-secret", "credential-test") },
				home,
			),
		);

		expect(statSync(join(path, "creds.json")).uid).toBe(runtimeId);
	});
});
