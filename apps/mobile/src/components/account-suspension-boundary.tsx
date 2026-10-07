import { accountSuspendedCopy, SUPPORT_MAILTO } from "@clawdi/shared/view";
import { useState } from "react";
import { Linking } from "react-native";
import { AccountSuspendedPage } from "@/components/account-suspended-page";
import { useI18n } from "@/lib/i18n";
import { useAppSignOut } from "@/platform/auth/auth-client";

/**
 * The single full-screen state shown once any account read returns hosted's `account_suspended`
 * problem. The root Stack guards every account route behind `useAccountSuspended`; signing out
 * starts a new account scope, which lifts the guard and returns to sign-in.
 */
export function AccountSuspendedScreen() {
	const t = useI18n();
	const signOut = useAppSignOut();
	const [signingOut, setSigningOut] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSignOut = async () => {
		setSigningOut(true);
		setError(null);
		try {
			await signOut();
		} catch {
			setError(accountSuspendedCopy.signOutFailed);
		} finally {
			setSigningOut(false);
		}
	};

	const contactSupport = async () => {
		setError(null);
		try {
			await Linking.openURL(SUPPORT_MAILTO);
		} catch {
			setError(t("runtime.supportFailed"));
		}
	};

	return (
		<AccountSuspendedPage
			onContactSupport={() => void contactSupport()}
			onSignOut={() => void handleSignOut()}
			signingOut={signingOut}
			error={error}
		/>
	);
}
