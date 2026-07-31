import { describe, expect, it } from "bun:test";
import {
	decideChatGptOAuthCredentialReconciliation,
	intentLedgerForDecision,
	type OAuthCredentialLedgerSnapshot,
} from "./chatgpt-oauth-reconciliation";

const seeded: OAuthCredentialLedgerSnapshot = {
	nativeProfileId: "native:provider-1",
	credentialRevision: "revision-1",
	state: "seeded",
};

describe("ChatGPT OAuth ownership ledger", () => {
	it("writes intent before the first native seed", () => {
		const decision = decideChatGptOAuthCredentialReconciliation({
			desiredCredentialRevision: "revision-1",
			desiredNativeProfileId: "native:provider-1",
			ledger: null,
			native: "missing",
		});
		expect(decision).toMatchObject({
			nativeAction: "seed",
			requiresWriteAheadIntent: true,
			nextLedger: seeded,
		});
		expect(
			intentLedgerForDecision({
				decision,
				current: null,
				desiredNativeProfileId: "native:provider-1",
				desiredCredentialRevision: "revision-1",
			}),
		).toEqual({
			nativeProfileId: "native:provider-1",
			credentialRevision: "revision-1",
			state: "intent",
			operation: "seed",
		});
	});

	it("adopts native rotation while recovering a same-revision seed intent", () => {
		const intent: OAuthCredentialLedgerSnapshot = {
			...seeded,
			state: "intent",
			operation: "seed",
		};
		expect(
			decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: "revision-1",
				desiredNativeProfileId: "native:provider-1",
				ledger: intent,
				native: "foreign",
			}),
		).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: { ...seeded, state: "adopted" },
		});
	});

	it("adopts even an exact native match after a seed intent because intent is not ownership", () => {
		const intent: OAuthCredentialLedgerSnapshot = {
			...seeded,
			state: "intent",
			operation: "seed",
			credentialFingerprint: `sha256:${"a".repeat(64)}`,
		};
		expect(
			decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: "revision-1",
				desiredNativeProfileId: "native:provider-1",
				ledger: intent,
				native: "managed",
			}),
		).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: { ...seeded, state: "adopted" },
		});
	});

	it("retries a seed after a kill when the namespaced native entry is still absent", () => {
		const intent: OAuthCredentialLedgerSnapshot = {
			...seeded,
			state: "intent",
			operation: "seed",
		};
		expect(
			decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: "revision-1",
				desiredNativeProfileId: seeded.nativeProfileId,
				ledger: intent,
				native: "missing",
			}),
		).toEqual({
			nativeAction: "seed",
			requiresWriteAheadIntent: true,
			nextLedger: seeded,
		});
	});

	it("does not retain removal authority after a kill following remove intent", () => {
		const firstDecision = decideChatGptOAuthCredentialReconciliation({
			desiredCredentialRevision: null,
			desiredNativeProfileId: null,
			ledger: seeded,
			native: "managed",
		});
		const persistedIntent = intentLedgerForDecision({
			decision: firstDecision,
			current: seeded,
			desiredNativeProfileId: seeded.nativeProfileId,
			desiredCredentialRevision: seeded.credentialRevision,
		});

		// Simulate process death before the native adapter executes, then restart.
		expect(persistedIntent).toEqual({
			...seeded,
			state: "intent",
			operation: "remove",
		});
		expect(
			decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: null,
				desiredNativeProfileId: null,
				ledger: persistedIntent,
				native: "managed",
			}),
		).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: {
				nativeProfileId: seeded.nativeProfileId,
				credentialRevision: seeded.credentialRevision,
				state: "retired",
			},
		});
	});

	it("retires adopted foreign material without claiming removal authority", () => {
		expect(
			decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: null,
				desiredNativeProfileId: null,
				ledger: { ...seeded, state: "adopted" },
				native: "foreign",
			}),
		).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: { ...seeded, state: "retired" },
		});
	});

	it("never resurrects logout material at the same revision", () => {
		const revoked = { ...seeded, state: "revoked" as const };
		expect(
			decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: "revision-1",
				desiredNativeProfileId: seeded.nativeProfileId,
				ledger: revoked,
				native: "missing",
			}),
		).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: revoked,
		});
	});

	it("preserves native refresh when a retired binding returns at the same revision", () => {
		expect(
			decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: "revision-1",
				desiredNativeProfileId: seeded.nativeProfileId,
				ledger: { ...seeded, state: "retired" },
				native: "foreign",
			}),
		).toEqual({
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: { ...seeded, state: "adopted" },
		});
	});

	it("reseeds a retired binding at the same revision only when native material is absent", () => {
		expect(
			decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: "revision-1",
				desiredNativeProfileId: seeded.nativeProfileId,
				ledger: { ...seeded, state: "retired" },
				native: "missing",
			}),
		).toEqual({
			nativeAction: "seed",
			requiresWriteAheadIntent: true,
			nextLedger: seeded,
		});
	});

	it("allows only a new credential revision to replace native material", () => {
		expect(
			decideChatGptOAuthCredentialReconciliation({
				desiredCredentialRevision: "revision-2",
				desiredNativeProfileId: seeded.nativeProfileId,
				ledger: { ...seeded, state: "adopted" },
				native: "foreign",
			}),
		).toEqual({
			nativeAction: "upsert",
			requiresWriteAheadIntent: true,
			nextLedger: {
				nativeProfileId: seeded.nativeProfileId,
				credentialRevision: "revision-2",
				state: "seeded",
			},
		});
	});
});
