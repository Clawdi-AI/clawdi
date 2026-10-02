import { useClerk, useUser } from "@clerk/expo";
import { useState } from "react";
import { NativeButton } from "../../src/ui/native-controls";
import { useI18n } from "../../src/i18n";
import { AppText, AppView } from "../../src/ui/primitives";

export default function AccountRoute() {
	const t = useI18n();
	const { isLoaded, user } = useUser();
	const { signOut } = useClerk();
	const [error, setError] = useState(false);
	const [busy, setBusy] = useState(false);
	const email = user?.primaryEmailAddress?.emailAddress;
	const onSignOut = async () => {
		setBusy(true);
		setError(false);
		try {
			await signOut();
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};
	return (
		<AppView className="flex-1 gap-8 bg-background px-6 pb-10 pt-8">
			<AppText className="text-3xl font-semibold text-foreground">{t("account.title")}</AppText>
			<AppView className="gap-2 rounded-3xl bg-surface p-5">
				<AppText className="text-sm text-muted">{t("account.signedInAs")}</AppText>
				<AppText className="text-lg font-semibold text-foreground">
					{isLoaded && email ? email : t("account.accountUnavailable")}
				</AppText>
			</AppView>
			{error ? <AppText className="text-base text-danger">{t("account.signOutFailed")}</AppText> : null}
			<NativeButton label={t("account.signOut")} onPress={() => void onSignOut()} disabled={busy} />
		</AppView>
	);
}
