import { useAuth } from "@clerk/expo";
import { Redirect, Slot } from "expo-router";
import { isMobilePreview } from "../config/preview";
import { useI18n } from "../i18n";
import { LoadingScreen } from "./feedback";

export function SignedInLayout() {
	if (isMobilePreview()) return <Slot />;
	const t = useI18n();
	const { isLoaded, isSignedIn } = useAuth();
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;
	return <Slot />;
}
