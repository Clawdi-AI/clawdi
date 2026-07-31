import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION,
	readOAuthCredentialLedger,
} from "./oauth-credential-ledger";

let root: string | null = null;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = null;
});

describe("OAuth credential ownership ledger persistence", () => {
	it("atomically migrates a legacy receipt in place", () => {
		root = mkdtempSync(join(tmpdir(), "clawdi-oauth-ledger-"));
		const path = join(root, "provider.json");
		writeFileSync(
			path,
			`${JSON.stringify({
				schemaVersion: "clawdi.runtimeOAuthCredential.v1",
				runtime: "hermes",
				providerId: "openai-codex",
				nativeProfileId: "clawdi:profile",
				credentialRevision: "revision-1",
				state: "seeded",
			})}\n`,
		);

		const ledger = readOAuthCredentialLedger(path);
		expect(ledger).toMatchObject({
			schemaVersion: OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION,
			runtime: "hermes",
			providerId: "openai-codex",
			state: "seeded",
		});
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(ledger);
		expect(readOAuthCredentialLedger(path)).toEqual(ledger);
	});
});
