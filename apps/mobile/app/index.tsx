import { Redirect } from "expo-router";
import { useAuth } from "@clerk/expo";
import { ConfigurationErrorScreen, LoadingScreen } from "../src/ui/feedback";
import { useMobileRuntimeConfig } from "../src/config/runtime";

export default function IndexRoute() {
	const runtime = useMobileRuntimeConfig();
	if (!runtime.ok) return <ConfigurationErrorScreen reason={runtime.reason} />;
	return <AuthenticatedIndex />;
}

function AuthenticatedIndex() {
	const { isLoaded, isSignedIn } = useAuth();
	if (!isLoaded) return <LoadingScreen />;
	if (!isSignedIn) return <Redirect href="/(auth)/sign-in" />;
	return <Redirect href="/(tabs)" />;
}
