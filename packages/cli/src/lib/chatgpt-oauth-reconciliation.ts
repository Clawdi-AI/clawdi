export type NativeOAuthCredentialObservationState = "missing" | "managed" | "foreign";

export interface NativeOAuthCredentialObservation {
	state: NativeOAuthCredentialObservationState;
	credentialFingerprint?: string;
}

export type OAuthCredentialLedgerStableState = "seeded" | "adopted" | "revoked";

export type OAuthCredentialLedgerState = "intent" | OAuthCredentialLedgerStableState;

export type OAuthCredentialIntentOperation = "seed" | "upsert" | "remove";

export interface OAuthCredentialLedgerSnapshot {
	nativeProfileId: string;
	credentialRevision: string;
	state: OAuthCredentialLedgerState;
	operation?: OAuthCredentialIntentOperation;
	credentialFingerprint?: string;
	beforeCredentialFingerprint?: string;
	targetCredentialFingerprint?: string;
}

export type NativeOAuthCredentialAction = "preserve" | OAuthCredentialIntentOperation;

export interface OAuthCredentialReconciliationDecision {
	nativeAction: NativeOAuthCredentialAction;
	nextLedger: OAuthCredentialLedgerSnapshot | null;
	requiresWriteAheadIntent: boolean;
	expectedCredentialFingerprint?: string;
	targetCredentialFingerprint?: string;
}

/**
 * Decide one native OAuth ownership transition.
 *
 * A caller must persist `intentLedgerForDecision` before executing every
 * decision with `requiresWriteAheadIntent`. Intent recovery only reports a
 * stable state when the observed credential fingerprint proves whether the
 * mutation completed. Otherwise the intent remains unresolved.
 */
export function decideChatGptOAuthCredentialReconciliation(input: {
	desiredCredentialRevision: string | null;
	desiredNativeProfileId: string | null;
	desiredCredentialFingerprint: string | null;
	ledger: OAuthCredentialLedgerSnapshot | null;
	native: NativeOAuthCredentialObservation;
}): OAuthCredentialReconciliationDecision {
	const {
		desiredCredentialRevision,
		desiredNativeProfileId,
		desiredCredentialFingerprint,
		ledger,
		native,
	} = input;

	if (desiredCredentialRevision === null) {
		return decideWithoutDesiredCredential(ledger, native);
	}
	if (desiredNativeProfileId === null || desiredCredentialFingerprint === null) {
		throw new Error("Desired OAuth credential requires native identity and fingerprint evidence");
	}

	if (ledger?.state === "intent") {
		return decideFromIntent({
			desiredCredentialRevision,
			desiredNativeProfileId,
			desiredCredentialFingerprint,
			ledger,
			native,
		});
	}

	if (
		ledger &&
		ledger.nativeProfileId === desiredNativeProfileId &&
		ledger.credentialRevision === desiredCredentialRevision
	) {
		if (native.state === "missing") {
			return preserveDecision({
				nativeProfileId: desiredNativeProfileId,
				credentialRevision: desiredCredentialRevision,
				state: "revoked",
			});
		}
		const exactOwnedFingerprint =
			ledger.state === "seeded" &&
			ledger.credentialFingerprint !== undefined &&
			native.credentialFingerprint === ledger.credentialFingerprint;
		if (ledger.state === "seeded" && (native.state === "managed" || exactOwnedFingerprint)) {
			return preserveDecision(
				seededLedger(
					desiredNativeProfileId,
					desiredCredentialRevision,
					ledger.credentialFingerprint,
				),
			);
		}
		return preserveDecision({
			nativeProfileId: desiredNativeProfileId,
			credentialRevision: desiredCredentialRevision,
			state: "adopted",
		});
	}

	if (native.state === "missing") {
		return seedDecision(
			desiredNativeProfileId,
			desiredCredentialRevision,
			desiredCredentialFingerprint,
			true,
		);
	}
	return upsertDecision(
		desiredNativeProfileId,
		desiredCredentialRevision,
		requireObservedFingerprint(native),
		desiredCredentialFingerprint,
		true,
	);
}

export function intentLedgerForDecision(
	decision: OAuthCredentialReconciliationDecision,
	currentLedger: OAuthCredentialLedgerSnapshot | null = null,
): OAuthCredentialLedgerSnapshot {
	if (!decision.requiresWriteAheadIntent || decision.nativeAction === "preserve") {
		throw new Error("OAuth credential decision does not require a write-ahead intent");
	}
	if (
		(decision.nativeAction === "upsert" || decision.nativeAction === "remove") &&
		!decision.expectedCredentialFingerprint
	) {
		throw new Error(`${decision.nativeAction} intent requires before-credential evidence`);
	}
	if (
		(decision.nativeAction === "seed" || decision.nativeAction === "upsert") &&
		!decision.targetCredentialFingerprint
	) {
		throw new Error(`${decision.nativeAction} intent requires target-credential evidence`);
	}
	const identity = decision.nextLedger ?? currentLedger;
	if (!identity) throw new Error("OAuth credential intent requires ledger identity");
	return {
		nativeProfileId: identity.nativeProfileId,
		credentialRevision: identity.credentialRevision,
		state: "intent",
		operation: decision.nativeAction,
		...(decision.expectedCredentialFingerprint
			? { beforeCredentialFingerprint: decision.expectedCredentialFingerprint }
			: {}),
		...(decision.targetCredentialFingerprint
			? { targetCredentialFingerprint: decision.targetCredentialFingerprint }
			: {}),
	};
}

function decideWithoutDesiredCredential(
	ledger: OAuthCredentialLedgerSnapshot | null,
	native: NativeOAuthCredentialObservation,
): OAuthCredentialReconciliationDecision {
	if (!ledger) return preserveDecision(null);
	if (ledger.state === "intent") {
		if (ledger.operation === "remove") {
			if (native.state === "missing") return preserveDecision(null);
			if (
				ledger.beforeCredentialFingerprint &&
				native.credentialFingerprint === ledger.beforeCredentialFingerprint
			) {
				return removeDecision(ledger.beforeCredentialFingerprint, false);
			}
			return preserveDecision(ledger);
		}

		const targetFingerprint = intentTargetFingerprint(ledger);
		if (targetFingerprint && native.credentialFingerprint === targetFingerprint) {
			return removeDecision(targetFingerprint, true);
		}
		if (ledger.operation === "seed" && native.state === "missing") {
			return preserveDecision(null);
		}
		if (
			ledger.operation === "upsert" &&
			ledger.beforeCredentialFingerprint &&
			native.credentialFingerprint === ledger.beforeCredentialFingerprint
		) {
			return preserveDecision(null);
		}
		return preserveDecision(ledger);
	}

	const owned =
		ledger.state === "seeded" &&
		native.state !== "missing" &&
		(native.state === "managed" ||
			(ledger.credentialFingerprint !== undefined &&
				native.credentialFingerprint === ledger.credentialFingerprint));
	if (owned) {
		return removeDecision(requireObservedFingerprint(native), true);
	}
	return preserveDecision(null);
}

function decideFromIntent(input: {
	desiredCredentialRevision: string;
	desiredNativeProfileId: string;
	desiredCredentialFingerprint: string;
	ledger: OAuthCredentialLedgerSnapshot;
	native: NativeOAuthCredentialObservation;
}): OAuthCredentialReconciliationDecision {
	const {
		desiredCredentialRevision,
		desiredNativeProfileId,
		desiredCredentialFingerprint,
		ledger,
		native,
	} = input;
	const sameIdentity =
		ledger.nativeProfileId === desiredNativeProfileId &&
		ledger.credentialRevision === desiredCredentialRevision;
	const targetFingerprint = intentTargetFingerprint(ledger);

	if (sameIdentity && ledger.operation === "seed") {
		if (native.state === "missing") {
			return seedDecision(
				desiredNativeProfileId,
				desiredCredentialRevision,
				targetFingerprint ?? desiredCredentialFingerprint,
				false,
			);
		}
		if (targetFingerprint && native.credentialFingerprint === targetFingerprint) {
			return preserveDecision(
				seededLedger(desiredNativeProfileId, desiredCredentialRevision, targetFingerprint),
			);
		}
		return preserveDecision(ledger);
	}

	if (sameIdentity && ledger.operation === "upsert") {
		if (targetFingerprint && native.credentialFingerprint === targetFingerprint) {
			return preserveDecision(
				seededLedger(desiredNativeProfileId, desiredCredentialRevision, targetFingerprint),
			);
		}
		if (
			ledger.beforeCredentialFingerprint &&
			native.credentialFingerprint === ledger.beforeCredentialFingerprint
		) {
			return upsertDecision(
				desiredNativeProfileId,
				desiredCredentialRevision,
				ledger.beforeCredentialFingerprint,
				targetFingerprint ?? desiredCredentialFingerprint,
				false,
			);
		}
		return preserveDecision(ledger);
	}

	if (sameIdentity && ledger.operation === "remove") {
		if (native.state === "missing") {
			return seedDecision(
				desiredNativeProfileId,
				desiredCredentialRevision,
				desiredCredentialFingerprint,
				true,
			);
		}
		if (
			ledger.beforeCredentialFingerprint &&
			native.credentialFingerprint === ledger.beforeCredentialFingerprint
		) {
			return preserveDecision(
				seededLedger(
					desiredNativeProfileId,
					desiredCredentialRevision,
					ledger.beforeCredentialFingerprint,
				),
			);
		}
		return preserveDecision(ledger);
	}

	if (native.state === "missing") {
		return seedDecision(
			desiredNativeProfileId,
			desiredCredentialRevision,
			desiredCredentialFingerprint,
			true,
		);
	}
	const provenCurrentFingerprint =
		(targetFingerprint && native.credentialFingerprint === targetFingerprint) ||
		(ledger.beforeCredentialFingerprint &&
			native.credentialFingerprint === ledger.beforeCredentialFingerprint)
			? native.credentialFingerprint
			: undefined;
	if (!provenCurrentFingerprint) return preserveDecision(ledger);
	return upsertDecision(
		desiredNativeProfileId,
		desiredCredentialRevision,
		provenCurrentFingerprint,
		desiredCredentialFingerprint,
		true,
	);
}

function seedDecision(
	nativeProfileId: string,
	credentialRevision: string,
	targetCredentialFingerprint: string,
	requiresWriteAheadIntent: boolean,
): OAuthCredentialReconciliationDecision {
	return {
		nativeAction: "seed",
		requiresWriteAheadIntent,
		targetCredentialFingerprint,
		nextLedger: seededLedger(nativeProfileId, credentialRevision, targetCredentialFingerprint),
	};
}

function upsertDecision(
	nativeProfileId: string,
	credentialRevision: string,
	expectedCredentialFingerprint: string,
	targetCredentialFingerprint: string,
	requiresWriteAheadIntent: boolean,
): OAuthCredentialReconciliationDecision {
	return {
		nativeAction: "upsert",
		requiresWriteAheadIntent,
		expectedCredentialFingerprint,
		targetCredentialFingerprint,
		nextLedger: seededLedger(nativeProfileId, credentialRevision, targetCredentialFingerprint),
	};
}

function removeDecision(
	expectedCredentialFingerprint: string,
	requiresWriteAheadIntent: boolean,
): OAuthCredentialReconciliationDecision {
	return {
		nativeAction: "remove",
		requiresWriteAheadIntent,
		expectedCredentialFingerprint,
		nextLedger: null,
	};
}

function preserveDecision(
	nextLedger: OAuthCredentialLedgerSnapshot | null,
): OAuthCredentialReconciliationDecision {
	return {
		nativeAction: "preserve",
		requiresWriteAheadIntent: false,
		nextLedger,
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

function intentTargetFingerprint(ledger: OAuthCredentialLedgerSnapshot): string | undefined {
	return ledger.targetCredentialFingerprint ?? ledger.credentialFingerprint;
}

function requireObservedFingerprint(native: NativeOAuthCredentialObservation): string {
	if (!native.credentialFingerprint) {
		throw new Error("Native OAuth credential is present without verifiable fingerprint evidence");
	}
	return native.credentialFingerprint;
}
