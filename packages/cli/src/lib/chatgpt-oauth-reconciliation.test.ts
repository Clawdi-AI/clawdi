import { describe, expect, it } from "bun:test";
import {
	decideChatGptOAuthCredentialReconciliation,
	intentLedgerForDecision,
	type NativeOAuthCredentialObservation,
	type OAuthCredentialLedgerSnapshot,
} from "./chatgpt-oauth-reconciliation";

const BEFORE_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const TARGET_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const AMBIGUOUS_FINGERPRINT = `sha256:${"c".repeat(64)}`;

const missing: NativeOAuthCredentialObservation = { state: "missing" };
const before: NativeOAuthCredentialObservation = {
	state: "foreign",
	credentialFingerprint: BEFORE_FINGERPRINT,
};
const target: NativeOAuthCredentialObservation = {
	state: "foreign",
	credentialFingerprint: TARGET_FINGERPRINT,
};
const ambiguous: NativeOAuthCredentialObservation = {
	state: "foreign",
	credentialFingerprint: AMBIGUOUS_FINGERPRINT,
};

const seeded: OAuthCredentialLedgerSnapshot = {
	nativeProfileId: "native:provider-1",
	credentialRevision: "revision-1",
	state: "seeded",
	credentialFingerprint: TARGET_FINGERPRINT,
};

function decide(input: {
	desiredCredentialRevision?: string | null;
	desiredNativeProfileId?: string | null;
	desiredCredentialFingerprint?: string | null;
	ledger: OAuthCredentialLedgerSnapshot | null;
	native: NativeOAuthCredentialObservation;
}) {
	return decideChatGptOAuthCredentialReconciliation({
		desiredCredentialRevision:
			input.desiredCredentialRevision === undefined
				? "revision-1"
				: input.desiredCredentialRevision,
		desiredNativeProfileId:
			input.desiredNativeProfileId === undefined
				? "native:provider-1"
				: input.desiredNativeProfileId,
		desiredCredentialFingerprint:
			input.desiredCredentialFingerprint === undefined
				? TARGET_FINGERPRINT
				: input.desiredCredentialFingerprint,
		ledger: input.ledger,
		native: input.native,
	});
}

describe("ChatGPT OAuth ownership ledger", () => {
	it("records target evidence before the first native seed", () => {
		const decision = decide({ ledger: null, native: missing });
		expect(decision).toMatchObject({
			nativeAction: "seed",
			requiresWriteAheadIntent: true,
			targetCredentialFingerprint: TARGET_FINGERPRINT,
			nextLedger: seeded,
		});
		expect(intentLedgerForDecision(decision)).toEqual({
			nativeProfileId: "native:provider-1",
			credentialRevision: "revision-1",
			state: "intent",
			operation: "seed",
			targetCredentialFingerprint: TARGET_FINGERPRINT,
		});
	});

	it("retries a seed only while the namespaced native entry is still missing", () => {
		const intent: OAuthCredentialLedgerSnapshot = {
			...seeded,
			state: "intent",
			operation: "seed",
			credentialFingerprint: undefined,
			targetCredentialFingerprint: TARGET_FINGERPRINT,
		};
		expect(decide({ ledger: intent, native: missing })).toMatchObject({
			nativeAction: "seed",
			requiresWriteAheadIntent: false,
			nextLedger: seeded,
		});
		expect(decide({ ledger: intent, native: target })).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: seeded,
		});
		expect(decide({ ledger: intent, native: ambiguous })).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: intent,
		});
	});

	it("turns a completed seed intent into an evidenced remove when it is no longer desired", () => {
		const seedIntent: OAuthCredentialLedgerSnapshot = {
			nativeProfileId: "native:provider-1",
			credentialRevision: "revision-1",
			state: "intent",
			operation: "seed",
			targetCredentialFingerprint: TARGET_FINGERPRINT,
		};
		const decision = decide({
			desiredCredentialRevision: null,
			desiredNativeProfileId: null,
			desiredCredentialFingerprint: null,
			ledger: seedIntent,
			native: target,
		});

		expect(decision).toMatchObject({
			nativeAction: "remove",
			requiresWriteAheadIntent: true,
			expectedCredentialFingerprint: TARGET_FINGERPRINT,
		});
		expect(intentLedgerForDecision(decision)).toEqual({
			nativeProfileId: "native:provider-1",
			credentialRevision: "revision-1",
			state: "intent",
			operation: "remove",
			beforeCredentialFingerprint: TARGET_FINGERPRINT,
		});
	});

	it("distinguishes upsert intent and retries only from the proven before credential", () => {
		const firstDecision = decide({ ledger: null, native: before });
		expect(firstDecision.nativeAction).toBe("upsert");
		const intent = intentLedgerForDecision(firstDecision);
		expect(intent).toEqual({
			nativeProfileId: "native:provider-1",
			credentialRevision: "revision-1",
			state: "intent",
			operation: "upsert",
			beforeCredentialFingerprint: BEFORE_FINGERPRINT,
			targetCredentialFingerprint: TARGET_FINGERPRINT,
		});
		expect(decide({ ledger: intent, native: before })).toMatchObject({
			nativeAction: "upsert",
			requiresWriteAheadIntent: false,
			expectedCredentialFingerprint: BEFORE_FINGERPRINT,
			targetCredentialFingerprint: TARGET_FINGERPRINT,
		});
		expect(decide({ ledger: intent, native: target })).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: seeded,
		});
		expect(decide({ ledger: intent, native: ambiguous })).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: intent,
		});
	});

	it("retries remove from before evidence and retires only after absence is proven", () => {
		const firstDecision = decide({
			desiredCredentialRevision: null,
			desiredNativeProfileId: null,
			desiredCredentialFingerprint: null,
			ledger: seeded,
			native: { state: "managed", credentialFingerprint: TARGET_FINGERPRINT },
		});
		const intent = intentLedgerForDecision(firstDecision);
		expect(intent).toEqual({
			nativeProfileId: "native:provider-1",
			credentialRevision: "revision-1",
			state: "intent",
			operation: "remove",
			beforeCredentialFingerprint: TARGET_FINGERPRINT,
		});
		expect(
			decide({
				desiredCredentialRevision: null,
				desiredNativeProfileId: null,
				desiredCredentialFingerprint: null,
				ledger: intent,
				native: target,
			}),
		).toMatchObject({
			nativeAction: "remove",
			requiresWriteAheadIntent: false,
			expectedCredentialFingerprint: TARGET_FINGERPRINT,
		});
		expect(
			decide({
				desiredCredentialRevision: null,
				desiredNativeProfileId: null,
				desiredCredentialFingerprint: null,
				ledger: intent,
				native: missing,
			}),
		).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-1",
				state: "retired",
			},
		});
		expect(
			decide({
				desiredCredentialRevision: null,
				desiredNativeProfileId: null,
				desiredCredentialFingerprint: null,
				ledger: intent,
				native: ambiguous,
			}),
		).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: intent,
		});
	});

	it("never resurrects logout material at the same revision", () => {
		const revoked = { ...seeded, state: "revoked" as const, credentialFingerprint: undefined };
		expect(decide({ ledger: revoked, native: missing })).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: revoked,
		});
	});

	it("preserves a runtime refresh while relinquishing removal ownership", () => {
		expect(decide({ ledger: seeded, native: ambiguous })).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: {
				nativeProfileId: seeded.nativeProfileId,
				credentialRevision: seeded.credentialRevision,
				state: "adopted",
			},
		});
	});

	it("uses an evidenced upsert for a new credential revision", () => {
		expect(
			decide({
				desiredCredentialRevision: "revision-2",
				desiredCredentialFingerprint: TARGET_FINGERPRINT,
				ledger: { ...seeded, state: "adopted", credentialFingerprint: undefined },
				native: before,
			}),
		).toMatchObject({
			nativeAction: "upsert",
			requiresWriteAheadIntent: true,
			expectedCredentialFingerprint: BEFORE_FINGERPRINT,
			targetCredentialFingerprint: TARGET_FINGERPRINT,
		});
	});
});
