import { useAuth } from "@clerk/expo";
import { Redirect, Stack } from "expo-router";
import { LoadingScreen } from "../../src/ui/feedback";

export default function AuthLayout() {
	const { isLoaded, isSignedIn } = useAuth();
	if (!isLoaded) return <LoadingScreen />;
	if (isSignedIn) return <Redirect href="/(tabs)" />;
	return <Stack screenOptions={{ headerShown: false, animation: "fade" }} />;
}
