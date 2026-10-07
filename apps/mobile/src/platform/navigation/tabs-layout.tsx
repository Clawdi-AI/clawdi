import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useCSSVariable } from "uniwind";
import { LoadingScreen } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import { useAppAuth } from "@/platform/auth/auth-client";

export default function TabsLayout() {
	const t = useI18n();
	const { isLoaded, isSignedIn } = useAppAuth();
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	if (!isSignedIn) return <Redirect href="/sign-in" />;
	return <AppTabs />;
}

function themeColor(value: string | number | undefined) {
	return typeof value === "string" ? value : undefined;
}

/** Native bottom tabs standing in for the Web sidebar's primary groups. */
function AppTabs() {
	const t = useI18n();
	const [background, foreground, muted, accent] = useCSSVariable([
		"--color-background",
		"--color-foreground",
		"--color-muted-foreground",
		"--color-accent",
	]);
	return (
		<NativeTabs
			labelVisibilityMode="labeled"
			backgroundColor={themeColor(background)}
			tintColor={themeColor(foreground)}
			iconColor={{ default: themeColor(muted), selected: themeColor(foreground) }}
			indicatorColor={themeColor(accent)}
			labelStyle={{
				default: { color: themeColor(muted), fontFamily: "Geist-Medium" },
				selected: { color: themeColor(foreground), fontFamily: "Geist-Medium" },
			}}
		>
			<NativeTabs.Trigger name="(overview)" testID="tab-overview">
				<NativeTabs.Trigger.Label>{t("navigation.home")}</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="square.grid.2x2" md="dashboard" />
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(agents)" testID="tab-agents">
				<NativeTabs.Trigger.Label>{t("navigation.agents")}</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="desktopcomputer" md="computer" />
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(sessions)" testID="tab-sessions">
				<NativeTabs.Trigger.Label>{t("navigation.sessions")}</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="bubble.left" md="chat_bubble" />
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(library)" testID="tab-library">
				<NativeTabs.Trigger.Label>{t("navigation.library")}</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="books.vertical" md="library_books" />
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="(account)" testID="tab-account">
				<NativeTabs.Trigger.Label>{t("navigation.account")}</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="person.crop.circle" md="person" />
			</NativeTabs.Trigger>
		</NativeTabs>
	);
}

export const unstable_settings = { initialRouteName: "(overview)" };
