import { describe, expect, it } from "bun:test";
import {
	decideChatGptOAuthCredentialReconciliation,
	type NativeOAuthCredentialObservation,
	type OAuthCredentialReceiptSnapshot,
	type OAuthCredentialReceiptState,
} from "./chatgpt-oauth-reconciliation";

interface ReconciliationCase {
	name: string;
	desiredCredentialRevision: string | null;
	desiredNativeProfileId: string | null;
	receipt: OAuthCredentialReceiptSnapshot | null;
	native: NativeOAuthCredentialObservation;
	expected: ReturnType<typeof decideChatGptOAuthCredentialReconciliation>;
}

function changedRevisionCase(state: OAuthCredentialReceiptState): ReconciliationCase {
	return {
		name: `upserts an explicit new revision after ${state}`,
		desiredCredentialRevision: "revision-2",
		desiredNativeProfileId: "native:provider-1",
		receipt: {
			nativeProfileId: "native:provider-1",
			credentialRevision: "revision-1",
			state,
		},
		native: "foreign",
		expected: {
			nativeAction: "upsert",
			nextReceipt: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-2",
				state: "seeded",
			},
		},
	};
}

describe("ChatGPT OAuth credential reconciliation", () => {
	const changedRevisionStates: OAuthCredentialReceiptState[] = ["seeded", "adopted", "revoked"];
	const cases: ReconciliationCase[] = [
		{
			name: "seeds an empty native store",
			desiredCredentialRevision: "revision-1",
			desiredNativeProfileId: "native:provider-1",
			receipt: null,
			native: "missing",
			expected: {
				nativeAction: "seed",
				nextReceipt: {
					nativeProfileId: "native:provider-1",
					credentialRevision: "revision-1",
					state: "seeded",
				},
			},
		},
		{
			name: "explicitly replaces a pre-existing native login on first binding",
			desiredCredentialRevision: "revision-1",
			desiredNativeProfileId: "native:provider-1",
			receipt: null,
			native: "foreign",
			expected: {
				nativeAction: "upsert",
				nextReceipt: {
					nativeProfileId: "native:provider-1",
					credentialRevision: "revision-1",
					state: "seeded",
				},
			},
		},
		{
			name: "preserves a managed credential at the same revision",
			desiredCredentialRevision: "revision-1",
			desiredNativeProfileId: "native:provider-1",
			receipt: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-1",
				state: "seeded",
			},
			native: "managed",
			expected: {
				nativeAction: "preserve",
				nextReceipt: {
					nativeProfileId: "native:provider-1",
					credentialRevision: "revision-1",
					state: "seeded",
				},
			},
		},
		{
			name: "adopts native rotation at the same revision",
			desiredCredentialRevision: "revision-1",
			desiredNativeProfileId: "native:provider-1",
			receipt: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-1",
				state: "seeded",
			},
			native: "foreign",
			expected: {
				nativeAction: "preserve",
				nextReceipt: {
					nativeProfileId: "native:provider-1",
					credentialRevision: "revision-1",
					state: "adopted",
				},
			},
		},
		{
			name: "tombstones native logout at the same revision",
			desiredCredentialRevision: "revision-1",
			desiredNativeProfileId: "native:provider-1",
			receipt: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-1",
				state: "seeded",
			},
			native: "missing",
			expected: {
				nativeAction: "preserve",
				nextReceipt: {
					nativeProfileId: "native:provider-1",
					credentialRevision: "revision-1",
					state: "revoked",
				},
			},
		},
		{
			name: "does not resurrect a revoked same revision",
			desiredCredentialRevision: "revision-1",
			desiredNativeProfileId: "native:provider-1",
			receipt: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-1",
				state: "revoked",
			},
			native: "missing",
			expected: {
				nativeAction: "preserve",
				nextReceipt: {
					nativeProfileId: "native:provider-1",
					credentialRevision: "revision-1",
					state: "revoked",
				},
			},
		},
		{
			name: "adopts native re-login at the same revision",
			desiredCredentialRevision: "revision-1",
			desiredNativeProfileId: "native:provider-1",
			receipt: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-1",
				state: "revoked",
			},
			native: "foreign",
			expected: {
				nativeAction: "preserve",
				nextReceipt: {
					nativeProfileId: "native:provider-1",
					credentialRevision: "revision-1",
					state: "adopted",
				},
			},
		},
		...changedRevisionStates.map(changedRevisionCase),
		{
			name: "migrates a legacy native profile identity without waiting for a new revision",
			desiredCredentialRevision: "revision-1",
			desiredNativeProfileId: "native:provider-1",
			receipt: {
				nativeProfileId: "openai:default",
				credentialRevision: "revision-1",
				state: "seeded",
			},
			native: "foreign",
			expected: {
				nativeAction: "upsert",
				nextReceipt: {
					nativeProfileId: "native:provider-1",
					credentialRevision: "revision-1",
					state: "seeded",
				},
			},
		},
		{
			name: "removes only a proven managed credential",
			desiredCredentialRevision: null,
			desiredNativeProfileId: null,
			receipt: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-1",
				state: "seeded",
			},
			native: "managed",
			expected: { nativeAction: "remove", nextReceipt: null },
		},
		{
			name: "preserves a foreign credential during removal",
			desiredCredentialRevision: null,
			desiredNativeProfileId: null,
			receipt: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-1",
				state: "seeded",
			},
			native: "foreign",
			expected: { nativeAction: "preserve", nextReceipt: null },
		},
		{
			name: "preserves an adopted credential during removal",
			desiredCredentialRevision: null,
			desiredNativeProfileId: null,
			receipt: {
				nativeProfileId: "native:provider-1",
				credentialRevision: "revision-1",
				state: "adopted",
			},
			native: "managed",
			expected: { nativeAction: "preserve", nextReceipt: null },
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(
				decideChatGptOAuthCredentialReconciliation({
					desiredCredentialRevision: testCase.desiredCredentialRevision,
					desiredNativeProfileId: testCase.desiredNativeProfileId,
					receipt: testCase.receipt,
					native: testCase.native,
				}),
			).toEqual(testCase.expected);
		});
	}
});
