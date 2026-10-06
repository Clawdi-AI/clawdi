import { Redirect, Stack } from "expo-router";
import { LoadingScreen } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import { useAppAuth } from "@/platform/auth/auth-client";
import { useNativeStackOptions } from "@/platform/navigation/native-header";
import { formSheetOptions } from "@/platform/navigation/sheet-options";

export default function LibraryLayout() {
	const t = useI18n();
	const { isLoaded, isSignedIn } = useAppAuth();
	const options = useNativeStackOptions();
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	if (!isSignedIn) return <Redirect href="/sign-in" />;
	return (
		<Stack screenOptions={options}>
			<Stack.Screen
				name="library"
				options={{ title: t("navigation.library"), headerLargeTitleEnabled: true }}
			/>
			<Stack.Screen
				name="projects/invitations"
				options={{ ...formSheetOptions, title: t("sharing.received") }}
			/>
			<Stack.Screen
				name="projects/[id]/sharing"
				options={{ ...formSheetOptions, title: "Share project" }}
			/>
			<Stack.Screen name="skills/new" options={{ ...formSheetOptions, title: "Create Skill" }} />
			<Stack.Screen
				name="skills/archive"
				options={{ ...formSheetOptions, title: t("skillArchive.title") }}
			/>
			<Stack.Screen
				name="skills/[key]/archive"
				options={{ ...formSheetOptions, title: t("skillArchive.title") }}
			/>
			<Stack.Screen name="channels/whatsapp" options={{ ...formSheetOptions, title: "WhatsApp" }} />
		</Stack>
	);
}
export const unstable_settings = { initialRouteName: "library" };
