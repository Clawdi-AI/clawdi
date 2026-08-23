import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
});
