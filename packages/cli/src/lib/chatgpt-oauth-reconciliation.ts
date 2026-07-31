export type NativeOAuthCredentialObservation = "missing" | "managed" | "foreign";

export type OAuthCredentialReceiptState = "seeded" | "adopted" | "revoked";

export interface OAuthCredentialReceiptSnapshot {
	nativeProfileId: string;
	credentialRevision: string;
	state: OAuthCredentialReceiptState;
}

export type NativeOAuthCredentialAction = "preserve" | "seed" | "upsert" | "remove";

export interface OAuthCredentialReconciliationDecision {
	nativeAction: NativeOAuthCredentialAction;
	nextReceipt: OAuthCredentialReceiptSnapshot | null;
}

/** Pure lifecycle decision shared by local apply and hosted runtime convergence. */
export function decideChatGptOAuthCredentialReconciliation(input: {
	desiredCredentialRevision: string | null;
	desiredNativeProfileId: string | null;
	receipt: OAuthCredentialReceiptSnapshot | null;
	native: NativeOAuthCredentialObservation;
}): OAuthCredentialReconciliationDecision {
	if (input.desiredCredentialRevision === null) {
		return {
			nativeAction:
				input.receipt?.state === "seeded" && input.native === "managed" ? "remove" : "preserve",
			nextReceipt: null,
		};
	}
	if (input.desiredNativeProfileId === null) {
		throw new Error("Desired OAuth credential requires a native profile identity");
	}

	if (!input.receipt) {
		return {
			nativeAction: input.native === "missing" ? "seed" : "upsert",
			nextReceipt: {
				nativeProfileId: input.desiredNativeProfileId,
				credentialRevision: input.desiredCredentialRevision,
				state: "seeded",
			},
		};
	}

	if (
		input.receipt.nativeProfileId !== input.desiredNativeProfileId ||
		input.receipt.credentialRevision !== input.desiredCredentialRevision
	) {
		return {
			nativeAction: "upsert",
			nextReceipt: {
				nativeProfileId: input.desiredNativeProfileId,
				credentialRevision: input.desiredCredentialRevision,
				state: "seeded",
			},
		};
	}

	if (input.native === "missing") {
		return {
			nativeAction: "preserve",
			nextReceipt: {
				nativeProfileId: input.desiredNativeProfileId,
				credentialRevision: input.desiredCredentialRevision,
				state: "revoked",
			},
		};
	}

	return {
		nativeAction: "preserve",
		nextReceipt: {
			nativeProfileId: input.desiredNativeProfileId,
			credentialRevision: input.desiredCredentialRevision,
			state: input.receipt.state === "seeded" && input.native === "managed" ? "seeded" : "adopted",
		},
	};
}
