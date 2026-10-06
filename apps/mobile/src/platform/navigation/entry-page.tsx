import { Redirect } from "expo-router";
import { ConfigurationErrorScreen, LoadingScreen } from "@/components/ui/feedback";
import { useMobileRuntimeConfig } from "@/lib/config/runtime";
import { useAppAuth } from "@/platform/auth/auth-client";

export default function IndexRoute() {
	const runtime = useMobileRuntimeConfig();
	if (!runtime.ok) return <ConfigurationErrorScreen reason={runtime.reason} />;
	return <AuthenticatedIndex />;
}

function AuthenticatedIndex() {
	const { isLoaded, isSignedIn } = useAppAuth();
	if (!isLoaded) return <LoadingScreen />;
	if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;
	return <Redirect href="/(tabs)" />;
}
