import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { OAuthCredentialLedgerSnapshot } from "./chatgpt-oauth-reconciliation";
import { writePrivateFileAtomic } from "./private-file";

export const OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION = "clawdi.oauthCredentialOwnership.v2";

const oauthCredentialLedgerSchema = z
	.object({
		schemaVersion: z.literal(OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION),
		runtime: z.enum(["codex", "hermes", "openclaw"]),
		providerId: z.string().min(1),
		nativeProfileId: z.string().min(1),
		credentialRevision: z.string().min(1).max(64),
		state: z.enum(["intent", "seeded", "adopted", "revoked", "retired"]),
		operation: z.enum(["seed", "remove"]).optional(),
		credentialFingerprint: z
			.string()
			.regex(/^sha256:[a-f0-9]{64}$/)
			.optional(),
	})
	.strict()
	.superRefine((ledger, context) => {
		if (ledger.state === "intent" && !ledger.operation) {
			context.addIssue({ code: "custom", message: "intent ledger requires an operation" });
		}
		if (ledger.state !== "intent" && ledger.operation) {
			context.addIssue({ code: "custom", message: "stable ledger cannot carry an operation" });
		}
	});

const legacyOAuthCredentialReceiptSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeOAuthCredential.v1"),
		runtime: z.enum(["codex", "hermes", "openclaw"]),
		providerId: z.string().min(1),
		nativeProfileId: z.string().min(1),
		credentialRevision: z.string().min(1).max(64),
		state: z.enum(["seeded", "adopted", "revoked"]),
		credentialFingerprint: z
			.string()
			.regex(/^sha256:[a-f0-9]{64}$/)
			.optional(),
	})
	.strict();

export type OAuthCredentialLedger = z.infer<typeof oauthCredentialLedgerSchema>;
export type OAuthCredentialLedgerRuntime = OAuthCredentialLedger["runtime"];

export function oauthCredentialLedgerPath(
	root: string,
	runtime: OAuthCredentialLedgerRuntime,
	providerId: string,
): string {
	const providerKey = createHash("sha256").update(providerId).digest("hex");
	return join(root, runtime, `${providerKey}.json`);
}

export function readOAuthCredentialLedger(
	path: string,
	options: { afterMigrate?: (path: string, parent: string) => void } = {},
): OAuthCredentialLedger | null {
	if (!existsSync(path)) return null;
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	const canonical = oauthCredentialLedgerSchema.safeParse(raw);
	if (canonical.success) return canonical.data;
	const legacy = legacyOAuthCredentialReceiptSchema.parse(raw);
	return writeOAuthCredentialLedger(
		path,
		{ runtime: legacy.runtime, providerId: legacy.providerId },
		{
			nativeProfileId: legacy.nativeProfileId,
			credentialRevision: legacy.credentialRevision,
			state: legacy.state,
			...(legacy.credentialFingerprint
				? { credentialFingerprint: legacy.credentialFingerprint }
				: {}),
		},
		{ afterWrite: options.afterMigrate },
	);
}

export function writeOAuthCredentialLedger(
	path: string,
	identity: Pick<OAuthCredentialLedger, "runtime" | "providerId">,
	snapshot: OAuthCredentialLedgerSnapshot,
	options: { afterWrite?: (path: string, parent: string) => void } = {},
): OAuthCredentialLedger {
	const ledger = oauthCredentialLedgerSchema.parse({
		schemaVersion: OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION,
		...identity,
		...snapshot,
	});
	writePrivateFileAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`, {
		mode: 0o600,
		dirMode: 0o700,
	});
	options.afterWrite?.(path, dirname(path));
	return ledger;
}

export function oauthCredentialLedgerSnapshot(
	ledger: OAuthCredentialLedger | null,
): OAuthCredentialLedgerSnapshot | null {
	if (!ledger) return null;
	return {
		nativeProfileId: ledger.nativeProfileId,
		credentialRevision: ledger.credentialRevision,
		state: ledger.state,
		...(ledger.operation ? { operation: ledger.operation } : {}),
		...(ledger.credentialFingerprint
			? { credentialFingerprint: ledger.credentialFingerprint }
			: {}),
	};
}
