import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION,
	readOAuthCredentialLedger,
	writeOAuthCredentialLedger,
} from "./oauth-credential-ledger";

let root: string | null = null;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = null;
});

describe("OAuth credential ownership ledger persistence", () => {
	it("persists operation evidence in the existing v2 ledger shape", () => {
		root = mkdtempSync(join(tmpdir(), "clawdi-oauth-ledger-"));
		const path = join(root, "provider.json");
		const beforeCredentialFingerprint = `sha256:${"a".repeat(64)}`;
		const targetCredentialFingerprint = `sha256:${"b".repeat(64)}`;
		const ledger = writeOAuthCredentialLedger(
			path,
			{ runtime: "openclaw", providerId: "openai-codex" },
			{
				nativeProfileId: "clawdi:profile",
				credentialRevision: "revision-2",
				state: "intent",
				operation: "upsert",
				beforeCredentialFingerprint,
				targetCredentialFingerprint,
			},
		);

		expect(ledger).toEqual({
			schemaVersion: OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION,
			runtime: "openclaw",
			providerId: "openai-codex",
			nativeProfileId: "clawdi:profile",
			credentialRevision: "revision-2",
			state: "intent",
			operation: "upsert",
			beforeCredentialFingerprint,
			targetCredentialFingerprint,
		});
		expect(readOAuthCredentialLedger(path)).toEqual(ledger);
	});

	it("reads a legacy receipt without migrating it unless explicitly requested", () => {
		root = mkdtempSync(join(tmpdir(), "clawdi-oauth-ledger-"));
		const path = join(root, "provider.json");
		const legacyBytes = `${JSON.stringify({
			schemaVersion: "clawdi.runtimeOAuthCredential.v1",
			runtime: "hermes",
			providerId: "openai-codex",
			nativeProfileId: "clawdi:profile",
			credentialRevision: "revision-1",
			state: "seeded",
		})}\n`;
		writeFileSync(path, legacyBytes);

		const ledger = readOAuthCredentialLedger(path);
		expect(ledger).toMatchObject({
			schemaVersion: OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION,
			runtime: "hermes",
			providerId: "openai-codex",
			state: "seeded",
		});
		expect(readFileSync(path, "utf8")).toBe(legacyBytes);

		const migrated = readOAuthCredentialLedger(path, { migrateLegacy: true });
		expect(migrated).toEqual(ledger);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(migrated);
		expect(readOAuthCredentialLedger(path)).toEqual(migrated);
	});
});
