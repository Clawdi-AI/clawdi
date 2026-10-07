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
	handleUnauthenticated: () => Promise<unknown>;
};

/**
 * "signed-out": Clerk's sign-out succeeded. "cleared": sign-out was rejected (the user
 * no longer exists) and Clerk refreshed the Client and Session itself. "failed": neither
 * reached Clerk, e.g. offline; retrying is safe.
 */
export type DeletedAccountSessionEnd = "signed-out" | "cleared" | "failed";

/**
 * Ends the local session of an account the hosted service just deleted. Clerk's
 * `signOut()` throws on any non-network Frontend API error, in both the single-session
 * (`client.removeSessions()`) and multi-session (`session.remove()`) paths, and leaves
 * local state untouched. The fallback is Clerk's documented `handleUnauthenticated()`,
 * which refetches the Client and clears sessions the server no longer has.
 */
export async function endDeletedAccountSession(
	clerk: DeletedAccountClerk,
	{ sessionId, redirectUrl }: { sessionId?: string; redirectUrl?: string } = {},
): Promise<DeletedAccountSessionEnd> {
	try {
		await clerk.signOut({ sessionId, redirectUrl });
		return "signed-out";
	} catch {
		// The deleted user's sessions cannot be removed through the Frontend API.
	}
	try {
		await clerk.handleUnauthenticated();
	} catch {
		return "failed";
	}
	const remaining = clerk.session?.id;
	return (sessionId ? remaining !== sessionId : !remaining) ? "cleared" : "failed";
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
