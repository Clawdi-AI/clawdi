import { useAuth } from "@clerk/expo";
import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useI18n } from "../../src/i18n";
import { LoadingScreen } from "../../src/ui/feedback";

export default function TabsLayout() {
	const t = useI18n();
	const { isLoaded, isSignedIn } = useAuth();
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;
	return (
		<NativeTabs>
			<NativeTabs.Trigger name="index">
				<NativeTabs.Trigger.Label>{t("navigation.home")}</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="house.fill" />
			</NativeTabs.Trigger>
			<NativeTabs.Trigger name="account">
				<NativeTabs.Trigger.Label>{t("navigation.account")}</NativeTabs.Trigger.Label>
				<NativeTabs.Trigger.Icon sf="person.crop.circle" />
			</NativeTabs.Trigger>
		</NativeTabs>
	);
}
