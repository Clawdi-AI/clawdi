import { Redirect, Slot } from "expo-router";
import { LoadingScreen } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import { useAppAuth } from "@/platform/auth/auth-client";

export function SignedInLayout() {
	const t = useI18n();
	const { isLoaded, isSignedIn } = useAppAuth();
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;
	return <Slot />;
}
