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
	"channels/index": "Channels",
	"ai-providers/index": "AI Providers",
	"settings/index": "Settings",
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
				// Unknown titles stay empty until the page sets its own; never show route names.
				title: roots[route.name] ?? "",
				headerLargeTitleEnabled: route.name in roots,
			})}
		/>
	);
}
