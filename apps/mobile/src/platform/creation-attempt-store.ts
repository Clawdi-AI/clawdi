import { parseCreationAttempt } from "@/hosted/billing/deploy/deploy-request";
import { type AttemptStore, createSerializedAttemptStore } from "@/platform/attempt-store";

export function createAttemptStore(store: AttemptStore) {
	return createSerializedAttemptStore(store, {
		parse: parseCreationAttempt,
		ownerError: "Creation owner changed",
		sameIntent: (previous, next) =>
			next.id === previous.id &&
			JSON.stringify(next.request) === JSON.stringify(previous.request) &&
			JSON.stringify(next.draft) === JSON.stringify(previous.draft) &&
			JSON.stringify(next.walletQuote) === JSON.stringify(previous.walletQuote),
	});
}
