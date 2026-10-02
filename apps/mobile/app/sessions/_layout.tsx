import { useAuth } from "@clerk/expo";
import { Redirect, Slot } from "expo-router";
import { useI18n } from "../../src/i18n";
import { LoadingScreen } from "../../src/ui/feedback";

export default function SessionsLayout() {
	const t = useI18n();
	const { isLoaded, isSignedIn } = useAuth();
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;
	return <Slot />;
}
