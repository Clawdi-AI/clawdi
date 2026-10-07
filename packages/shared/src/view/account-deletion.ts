import type { DeployComponents } from "../api";
import {
	STORE_BILLED_THROUGH,
	type StoreManagementProvider,
	storeSubscriptionCopy,
} from "./store-management";

/** Copy for the hosted account deletion page shown inside Clerk's user profile on Web and mobile. */
export const accountDeletionCopy = {
	title: "Delete account",
	warning:
		"This permanently terminates your Clawdi account and starts cleanup of hosted Agents, credentials and associated account data. You will lose access. Cleanup may continue asynchronously.",
	billing:
		"Card-billed subscriptions are cancelled immediately, and any unused Wallet balance and credits are forfeited.",
	storeNoticeTitle: "Cancel App Store or Google Play subscriptions first",
	storeNotice:
		"A Clawdi subscription billed by the App Store or Google Play keeps renewing after your account is deleted. Cancel it in App Store or Google Play subscriptions first. Deleting your account is not a refund request.",
	manageAppStore: "Manage App Store subscriptions",
	manageGooglePlay: "Manage Google Play subscriptions",
	action: "Delete account",
	confirmTitle: "Delete account?",
	confirm: "Permanently delete account",
	cancel: "Cancel",
	deleting: "Deleting your account…",
	unavailable:
		"Account deletion requires the hosted account service. It is not configured in this build; use Clawdi on the web or contact support.",
	accepted:
		"The account service acknowledged your deletion request. Resource cleanup may still be running. Sign out of this device; this page cannot verify final cleanup or subscription cancellation.",
	uncertain:
		"Deletion has not been confirmed. The request may already have been accepted. Do not assume your account or subscriptions are unchanged. Sign out and contact support to verify the outcome; no request will be retried automatically.",
	signOut: "Sign out",
	signOutFailed: "Couldn't finish signing out. Check your connection and try again.",
} as const;

type AccountSubscription = Pick<
	DeployComponents["schemas"]["V2ComputeSubscriptionListItem"],
	"funding_source" | "store_management"
>;

/** Store contract states that can still renew after account deletion. */
const RENEWABLE_STORE_STATES = new Set([
	"active",
	"grace",
	"lapsed",
	"paused",
	"canceled_pending_end",
]);

export type AccountDeletionStoreNotice =
	| { kind: "none" }
	| { kind: "generic" }
	| { kind: "store"; provider: StoreManagementProvider };

/**
 * Chooses the store-billing notice from the account's subscriptions. `rows` is null
 * while the list is unavailable; `complete` is false until every page has loaded.
 * Anything short of a complete list falls back to the generic notice.
 */
export function accountDeletionStoreNotice(
	rows: readonly AccountSubscription[] | null,
	complete: boolean,
): AccountDeletionStoreNotice {
	const storeRows = (rows ?? []).filter((row) => row.funding_source === "store");
	const renewable = storeRows.find(
		(row) => row.store_management && RENEWABLE_STORE_STATES.has(row.store_management.state),
	)?.store_management;
	if (renewable) return { kind: "store", provider: renewable.provider };
	if (!rows || !complete || storeRows.some((row) => !row.store_management)) {
		return { kind: "generic" };
	}
	return { kind: "none" };
}

/** Apple's deletion guidance: billing continues through the store until cancelled there. */
export function accountDeletionStoreNoticeCopy(provider: StoreManagementProvider): {
	title: string;
	description: string;
} {
	const store = storeSubscriptionCopy.providers[provider];
	return {
		title: `Cancel your ${store} subscription first`,
		description: `Your Clawdi compute subscription is billed by ${STORE_BILLED_THROUGH[provider]} and will keep renewing after your account is deleted. Cancel it in ${store} subscriptions first.`,
	};
}

/** Store subscription management pages documented by Apple and Google Play. */
export const STORE_SUBSCRIPTIONS_URL = {
	appStore: "https://apps.apple.com/account/subscriptions",
	googlePlay: "https://play.google.com/store/account/subscriptions",
} as const;

/**
 * Clerk's built-in delete owns the entry while the instance allows self-deletion.
 * The hosted page replaces it only once self-deletion is disabled, so the profile
 * never shows two delete entries.
 */
export function shouldShowAccountDeletionPage(user: object | null | undefined): boolean {
	return user != null && "deleteSelfEnabled" in user && user.deleteSelfEnabled === false;
}

/** Minimal Clerk surface shared by `@clerk/expo` and the Web Clerk SDK. */
export type DeletedAccountClerk = {
	readonly session?: { id: string } | null;
	signOut: (options?: { sessionId?: string; redirectUrl?: string }) => Promise<unknown>;
	setActive: (params: { session: null }) => Promise<unknown>;
	addListener: (listener: (resources: { session?: { id: string } | null }) => void) => () => void;
};

/** "failed": Clerk did not clear the session in time; retrying is safe. */
export type DeletedAccountSessionEnd = "signed-out" | "failed";

/** How long the fallback waits for Clerk to drop the deleted session. */
export const DELETED_SESSION_CLEAR_TIMEOUT_MS = 10_000;

/**
 * Ends the local session of an account the hosted service just deleted.
 *
 * clerk-js `signOut()` first puts the session into its transitive `undefined` state,
 * then removes it through the Frontend API (`client.removeSessions()` or
 * `session.remove()`). On any non-network error it rethrows and leaves the session
 * `undefined`, which also turns `handleUnauthenticated()` into a no-op. The fallback is
 * the documented `setActive({ session: null })`, which clears the session locally; the
 * server already ended it with the user. Completion is observed through `addListener`,
 * where `undefined` still means "in transition".
 */
export async function endDeletedAccountSession(
	clerk: DeletedAccountClerk,
	{
		sessionId,
		redirectUrl,
		timeoutMs = DELETED_SESSION_CLEAR_TIMEOUT_MS,
	}: { sessionId?: string; redirectUrl?: string; timeoutMs?: number } = {},
): Promise<DeletedAccountSessionEnd> {
	const deletedSessionId = sessionId ?? clerk.session?.id;
	try {
		await clerk.signOut({ sessionId, redirectUrl });
		return "signed-out";
	} catch {
		// The deleted user's sessions cannot be removed through the Frontend API.
	}
	if (!deletedSessionId) return "signed-out";
	const cleared = await new Promise<boolean>((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		const finish = (result: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			resolve(result);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		try {
			unsubscribe = clerk.addListener(({ session }) => {
				if (session !== undefined && session?.id !== deletedSessionId) finish(true);
			});
			if (settled) unsubscribe();
			else clerk.setActive({ session: null }).catch(() => finish(false));
		} catch {
			finish(false);
		}
	});
	return cleared ? "signed-out" : "failed";
}

export type AccountDeletionResult =
	| { outcome: "deleted"; session: DeletedAccountSessionEnd }
	| { outcome: "uncertain" };

/**
 * Requests hosted account termination (`DELETE /v1/me`), then ends the local session.
 * A lost response cannot prove that termination was rejected, and a later 401/403 is
 * not proof of deletion, so any failure is "uncertain" and is never retried.
 */
export async function deleteAccountThenSignOut({
	deleteAccount,
	endSession,
}: {
	deleteAccount: () => Promise<unknown>;
	endSession: () => Promise<DeletedAccountSessionEnd>;
}): Promise<AccountDeletionResult> {
	try {
		await deleteAccount();
	} catch {
		return { outcome: "uncertain" };
	}
	return { outcome: "deleted", session: await endSession() };
}
