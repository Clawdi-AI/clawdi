import { shouldShowAccountDeletionPage } from "@clawdi/shared/view";
import { useUser } from "@clerk/expo";
import { type UserProfileCustomPage, UserProfileView } from "@clerk/expo/native";
import { Stack, useRouter } from "expo-router";
import { useMemo } from "react";
import { DeleteAccountPage } from "@/hosted/account/delete-account-page";
import { useI18n } from "@/lib/i18n";
import { ClerkOnly } from "@/platform/auth/clerk-only";

/** Clerk's native profile owns its chrome; sign-out reaches the auth gates through the synced JS session. */
export default function AccountSettingsRoute() {
	const router = useRouter();
	return (
		<>
			<Stack.Screen options={{ headerShown: false }} />
			<ClerkOnly>
				<AccountProfile onHostBack={router.back} />
			</ClerkOnly>
		</>
	);
}

function AccountProfile({ onHostBack }: { onHostBack: () => void }) {
	const t = useI18n();
	const { user } = useUser();
	const showDeletionPage = shouldShowAccountDeletionPage(user);
	// Replaces Clerk's built-in delete, which the native view hides once self-deletion is off.
	const customPages = useMemo<UserProfileCustomPage[] | undefined>(
		() =>
			showDeletionPage
				? [
						{
							path: "delete-account",
							label: t("accountDeletion.title"),
							icon: "warning",
							placement: { type: "sectionEnd", section: "account" },
							content: <DeleteAccountPage />,
						},
					]
				: undefined,
		[showDeletionPage, t],
	);
	return (
		<UserProfileView
			isDismissible={false}
			onHostBack={onHostBack}
			customPages={customPages}
			style={{ flex: 1 }}
		/>
	);
}
