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
import { dirname, join } from "node:path";
import {
	managedWhatsAppAuthReceiptPath,
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
					authDir: path,
					files: [{ path: "creds.json", secretRef: SECRET_REF }],
				},
			],
		},
		recovery: {},
	};
}

function credsJson(secret = "managed-secret"): string {
	return JSON.stringify({
		advSecretKey: secret,
		additionalData: {
			"clawdi.managedWhatsAppSocket": {
				schemaVersion: "clawdi.managedWhatsAppSocket.v1",
				capability: `clawdi_${"a".repeat(32)}`,
				authCert: {
					SERIAL: 7,
					ISSUER: "clawdi",
					PUBLIC_KEY: {
						type: "Buffer",
						data: Buffer.alloc(32, 7).toString("base64"),
					},
				},
			},
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

describe("managed WhatsApp auth receipts", () => {
	test("materializes ownership out of tree and removes it with the auth directory", () => {
		const path = authDir();
		const desired = manifest(path);
		materializeHostedChannelCredentials(desired, { [SECRET_REF]: credsJson() }, home);

		const receipt = managedWhatsAppAuthReceiptPath(path);
		expect(readdirSync(path)).toEqual(["creds.json"]);
		expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
			schemaVersion: "clawdi.managedWhatsAppAuthReceipt.v1",
			markerSchemaVersion: "clawdi.managedWhatsAppAuth.v1",
			authDir: path,
			credentialId: "credential-test",
		});

		materializeHostedChannelCredentials(
			{ ...desired, projection: { ...desired.projection, channelCredentials: [] } },
			{},
			home,
		);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(receipt)).toBe(false);
	});

	test("adopts a 0.13.92 tree marker without replacing session state", () => {
		const path = authDir();
		mkdirSync(path, { recursive: true });
		const sessionPath = join(path, "session-key.json");
		writeFileSync(join(path, "creds.json"), `${credsJson("legacy-secret")}\n`);
		writeFileSync(sessionPath, '{"preserved":true}\n');
		writeFileSync(join(path, LEGACY_MARKER), legacyMarker());
		const sessionBefore = { bytes: readFileSync(sessionPath), inode: statSync(sessionPath).ino };
		const desired = manifest(path);

		validateHostedChannelCredentialsPlan(
			desired,
			{ [SECRET_REF]: credsJson("legacy-secret") },
			home,
		);
		expect(existsSync(join(path, LEGACY_MARKER))).toBe(true);
		expect(existsSync(managedWhatsAppAuthReceiptPath(path))).toBe(false);

		materializeHostedChannelCredentials(
			desired,
			{ [SECRET_REF]: credsJson("legacy-secret") },
			home,
		);
		expect(existsSync(join(path, LEGACY_MARKER))).toBe(false);
		expect(existsSync(managedWhatsAppAuthReceiptPath(path))).toBe(true);
		expect(readFileSync(sessionPath)).toEqual(sessionBefore.bytes);
		expect(statSync(sessionPath).ino).toBe(sessionBefore.inode);
	});

	test("does not adopt missing or malformed ownership state", () => {
		const cases: Array<{ name: string; seedOwnership(path: string): void }> = [
			{ name: "missing", seedOwnership: () => undefined },
			{
				name: "malformed-legacy",
				seedOwnership: (path) => writeFileSync(join(path, LEGACY_MARKER), "{}\n"),
			},
			{
				name: "malformed-receipt",
				seedOwnership: (path) => {
					writeFileSync(join(path, LEGACY_MARKER), legacyMarker());
					const receipt = managedWhatsAppAuthReceiptPath(path);
					mkdirSync(dirname(receipt), { recursive: true });
					writeFileSync(receipt, "{}\n", { mode: 0o600 });
				},
			},
		];
		for (const testCase of cases) {
			const path = authDir(testCase.name);
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "creds.json"), `${credsJson("user-secret")}\n`);
			testCase.seedOwnership(path);

			expect(() =>
				materializeHostedChannelCredentials(manifest(path), { [SECRET_REF]: credsJson() }, home),
			).toThrow(`refusing to overwrite unmanaged WhatsApp auth directory ${path}`);
		}
	});

	test("keeps the receipt platform-owned while materializing auth as the runtime user", () => {
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
			materializeHostedChannelCredentials(manifest(path), { [SECRET_REF]: credsJson() }, home),
		);

		expect(statSync(join(path, "creds.json")).uid).toBe(runtimeId);
		const receipt = statSync(managedWhatsAppAuthReceiptPath(path));
		expect(receipt.uid).toBe(0);
		expect(receipt.mode & 0o777).toBe(0o600);
	});
});
