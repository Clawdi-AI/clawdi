export type NativeOAuthCredentialObservation = "missing" | "managed" | "foreign";

export type OAuthCredentialLedgerStableState = "seeded" | "adopted" | "revoked" | "retired";

export type OAuthCredentialLedgerState = "intent" | OAuthCredentialLedgerStableState;

export interface OAuthCredentialLedgerSnapshot {
	nativeProfileId: string;
	credentialRevision: string;
	state: OAuthCredentialLedgerState;
	operation?: "seed" | "remove";
	credentialFingerprint?: string;
}

export type NativeOAuthCredentialAction = "preserve" | "seed" | "upsert" | "remove";

export interface OAuthCredentialReconciliationDecision {
	nativeAction: NativeOAuthCredentialAction;
	nextLedger: OAuthCredentialLedgerSnapshot;
	requiresWriteAheadIntent: boolean;
}

/**
 * Decide one native OAuth ownership transition.
 *
 * A caller must persist `intentLedgerForDecision` before executing every
 * decision with `requiresWriteAheadIntent`. If recovery observes native
 * material for a same-revision seed intent, it adopts that material instead
 * of replaying the write: the native agent may already have rotated the
 * refresh token after the original seed completed.
 */
export function decideChatGptOAuthCredentialReconciliation(input: {
	desiredCredentialRevision: string | null;
	desiredNativeProfileId: string | null;
	ledger: OAuthCredentialLedgerSnapshot | null;
	native: NativeOAuthCredentialObservation;
}): OAuthCredentialReconciliationDecision {
	const { desiredCredentialRevision, desiredNativeProfileId, ledger, native } = input;

	if (desiredCredentialRevision === null) {
		const nativeAction = ledger?.state === "seeded" && native === "managed" ? "remove" : "preserve";
		return {
			nativeAction,
			requiresWriteAheadIntent: nativeAction === "remove",
			nextLedger: retiredLedger(ledger),
		};
	}
	if (desiredNativeProfileId === null) {
		throw new Error("Desired OAuth credential requires a native profile identity");
	}

	if (
		ledger?.state === "intent" &&
		ledger.operation === "seed" &&
		ledger.nativeProfileId === desiredNativeProfileId &&
		ledger.credentialRevision === desiredCredentialRevision
	) {
		if (native !== "missing") {
			return {
				nativeAction: "preserve",
				requiresWriteAheadIntent: false,
				nextLedger: {
					nativeProfileId: desiredNativeProfileId,
					credentialRevision: desiredCredentialRevision,
					state: "adopted",
				},
			};
		}
		return {
			nativeAction: "seed",
			requiresWriteAheadIntent: true,
			nextLedger: seededLedger(
				desiredNativeProfileId,
				desiredCredentialRevision,
				ledger.credentialFingerprint,
			),
		};
	}

	if (
		ledger &&
		ledger.nativeProfileId === desiredNativeProfileId &&
		ledger.credentialRevision === desiredCredentialRevision
	) {
		if (native === "missing") {
			if (ledger.state === "retired") {
				return {
					nativeAction: "seed",
					requiresWriteAheadIntent: true,
					nextLedger: seededLedger(
						desiredNativeProfileId,
						desiredCredentialRevision,
						ledger.credentialFingerprint,
					),
				};
			}
			return {
				nativeAction: "preserve",
				requiresWriteAheadIntent: false,
				nextLedger: {
					nativeProfileId: desiredNativeProfileId,
					credentialRevision: desiredCredentialRevision,
					state: "revoked",
				},
			};
		}
		return {
			nativeAction: "preserve",
			requiresWriteAheadIntent: false,
			nextLedger: {
				nativeProfileId: desiredNativeProfileId,
				credentialRevision: desiredCredentialRevision,
				state: ledger.state === "seeded" && native === "managed" ? "seeded" : "adopted",
				...(ledger.state === "seeded" && native === "managed" && ledger.credentialFingerprint
					? { credentialFingerprint: ledger.credentialFingerprint }
					: {}),
			},
		};
	}

	const nativeAction = native === "missing" ? "seed" : "upsert";
	return {
		nativeAction,
		requiresWriteAheadIntent: true,
		nextLedger: seededLedger(desiredNativeProfileId, desiredCredentialRevision),
	};
}

export function intentLedgerForDecision(input: {
	decision: OAuthCredentialReconciliationDecision;
	current: OAuthCredentialLedgerSnapshot | null;
	desiredNativeProfileId: string;
	desiredCredentialRevision: string;
	credentialFingerprint?: string;
}): OAuthCredentialLedgerSnapshot {
	if (!input.decision.requiresWriteAheadIntent) {
		throw new Error("OAuth credential decision does not require a write-ahead intent");
	}
	return {
		nativeProfileId: input.desiredNativeProfileId,
		credentialRevision: input.desiredCredentialRevision,
		state: "intent",
		operation: input.decision.nativeAction === "remove" ? "remove" : "seed",
		...(input.credentialFingerprint
			? { credentialFingerprint: input.credentialFingerprint }
			: input.current?.credentialFingerprint
				? { credentialFingerprint: input.current.credentialFingerprint }
				: {}),
	};
}

function seededLedger(
	nativeProfileId: string,
	credentialRevision: string,
	credentialFingerprint?: string,
): OAuthCredentialLedgerSnapshot {
	return {
		nativeProfileId,
		credentialRevision,
		state: "seeded",
		...(credentialFingerprint ? { credentialFingerprint } : {}),
	};
}

function retiredLedger(
	ledger: OAuthCredentialLedgerSnapshot | null,
): OAuthCredentialLedgerSnapshot {
	return {
		nativeProfileId: ledger?.nativeProfileId ?? "retired",
		credentialRevision: ledger?.credentialRevision ?? "retired",
		state: "retired",
	};
}
