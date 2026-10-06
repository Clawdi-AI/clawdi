import { Redirect, Stack } from "expo-router";
import { LoadingScreen } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import { useAppAuth } from "@/platform/auth/auth-client";

import { useNativeStackOptions } from "@/platform/navigation/native-header";

const roots: Record<string, string> = {
	index: "Overview",
	"agents/index": "Agents",
	"sessions/index": "Sessions",
	library: "Library",
	"settings/index": "General",
};

export function SignedInLayout() {
	const t = useI18n();
	const options = useNativeStackOptions();
	const { isLoaded, isSignedIn } = useAppAuth();
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	if (!isSignedIn) return <Redirect href="/sign-in" />;
	return (
		<Stack
			screenOptions={({ route }) => ({
				...options,
				title: roots[route.name],
				headerLargeTitleEnabled: route.name in roots,
			})}
		/>
	);
}
