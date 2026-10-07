/** Copy for the hosted account deletion page shown inside Clerk's user profile on Web and mobile. */
export const accountDeletionCopy = {
	title: "Delete account",
	description: "Permanently delete your Clawdi account.",
	warning:
		"This permanently terminates your Clawdi account and starts cleanup of hosted Agents, credentials and associated account data. You will lose access. Cleanup may continue asynchronously.",
	storeNoticeTitle: "Cancel App Store or Google Play subscriptions first",
	storeNotice:
		"A Clawdi subscription billed by the App Store or Google Play keeps renewing after your account is deleted. Cancel it in App Store or Google Play subscriptions first. Deleting your account is not a refund request.",
	manageAppStore: "Manage App Store subscriptions",
	manageGooglePlay: "Manage Google Play subscriptions",
	action: "Delete account",
	confirmTitle: "Delete account?",
	confirm: "Permanently delete account",
	cancel: "Cancel",
	unavailable:
		"Account deletion requires the hosted account service. It is not configured in this build; use Clawdi on the web or contact support.",
	accepted:
		"The account service acknowledged your deletion request. Resource cleanup may still be running. Sign out of this device; this page cannot verify final cleanup or subscription cancellation.",
	uncertain:
		"Deletion has not been confirmed. The request may already have been accepted. Do not assume your account or subscriptions are unchanged. Sign out and contact support to verify the outcome; no request will be retried automatically.",
	signOut: "Sign out",
	signOutFailed: "Sign-out failed. Try again.",
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

export type AccountDeletionResult =
	| { outcome: "signed-out" }
	| { outcome: "accepted"; signOutFailed: true }
	| { outcome: "uncertain" };

/**
 * Requests hosted account termination (`DELETE /v1/me`), then ends the local session.
 * A lost response cannot prove that termination was rejected, and a later 401/403 is
 * not proof of deletion, so any failure is "uncertain" and is never retried.
 */
export async function deleteAccountThenSignOut({
	deleteAccount,
	signOut,
}: {
	deleteAccount: () => Promise<unknown>;
	signOut: () => Promise<unknown>;
}): Promise<AccountDeletionResult> {
	try {
		await deleteAccount();
	} catch {
		return { outcome: "uncertain" };
	}
	try {
		await signOut();
		return { outcome: "signed-out" };
	} catch {
		return { outcome: "accepted", signOutFailed: true };
	}
}
