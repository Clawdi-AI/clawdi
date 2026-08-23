import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { OAuthCredentialLedgerSnapshot } from "./chatgpt-oauth-reconciliation";
import { writePrivateFileAtomic } from "./private-file";

export const OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION = "clawdi.oauthCredentialOwnership.v2";

const oauthCredentialLedgerSchema = z
	.object({
		schemaVersion: z.literal(OAUTH_CREDENTIAL_LEDGER_SCHEMA_VERSION),
		runtime: z.enum(["hermes", "openclaw"]),
		providerId: z.string().min(1),
		nativeProfileId: z.string().min(1),
		credentialRevision: z.string().min(1).max(64),
		state: z.enum(["intent", "seeded", "adopted", "revoked"]),
		operation: z.enum(["seed", "upsert", "remove"]).optional(),
		credentialFingerprint: z
			.string()
			.regex(/^sha256:[a-f0-9]{64}$/)
			.optional(),
		beforeCredentialFingerprint: z
			.string()
			.regex(/^sha256:[a-f0-9]{64}$/)
			.optional(),
		targetCredentialFingerprint: z
			.string()
			.regex(/^sha256:[a-f0-9]{64}$/)
			.optional(),
	})
	.strict()
	.superRefine((ledger, context) => {
		if (ledger.state === "intent" && !ledger.operation) {
			context.addIssue({ code: "custom", message: "intent ledger requires an operation" });
		}
		if (
			ledger.state === "intent" &&
			(ledger.operation === "seed" || ledger.operation === "upsert") &&
			!ledger.targetCredentialFingerprint
		) {
			context.addIssue({
				code: "custom",
				message: "credential write intent requires target evidence",
			});
		}
		if (
			ledger.state === "intent" &&
			(ledger.operation === "upsert" || ledger.operation === "remove") &&
			!ledger.beforeCredentialFingerprint
		) {
			context.addIssue({
				code: "custom",
				message: "credential mutation intent requires before evidence",
			});
		}
		if (ledger.state !== "intent" && ledger.operation) {
			context.addIssue({ code: "custom", message: "stable ledger cannot carry an operation" });
		}
		if (
			ledger.state !== "intent" &&
			(ledger.beforeCredentialFingerprint || ledger.targetCredentialFingerprint)
		) {
			context.addIssue({ code: "custom", message: "stable ledger cannot carry intent evidence" });
		}
	});

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

export function readOAuthCredentialLedger(path: string): OAuthCredentialLedger | null {
	if (!existsSync(path)) return null;
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	// SUNSET: remove after the fleet no longer carries pre-#1187 retired tombstones.
	if (typeof raw === "object" && raw !== null && "state" in raw && raw.state === "retired") {
		rmSync(path, { force: true });
		return null;
	}
	return oauthCredentialLedgerSchema.parse(raw);
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
		...(ledger.beforeCredentialFingerprint
			? { beforeCredentialFingerprint: ledger.beforeCredentialFingerprint }
			: {}),
		...(ledger.targetCredentialFingerprint
			? { targetCredentialFingerprint: ledger.targetCredentialFingerprint }
			: {}),
	};
}
