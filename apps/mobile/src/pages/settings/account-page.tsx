import { UserProfileView } from "@clerk/expo/native";
import { Stack, useRouter } from "expo-router";
import { ClerkOnly } from "@/platform/auth/clerk-only";

/** Clerk's native profile owns its chrome; sign-out reaches the auth gates through the synced JS session. */
export default function AccountSettingsRoute() {
	const router = useRouter();
	return (
		<>
			<Stack.Screen options={{ headerShown: false }} />
			<ClerkOnly>
				<UserProfileView isDismissible={false} onHostBack={router.back} style={{ flex: 1 }} />
			</ClerkOnly>
		</>
	);
}
