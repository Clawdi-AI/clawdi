import { useAuth } from "@clerk/expo";
import { Redirect, Stack } from "expo-router";
import { LoadingScreen } from "../../src/ui/feedback";
import { ReadScreen } from "../../src/ui/read-screen";

export default function AuthLayout() {
	const { isLoaded, isSignedIn } = useAuth();
	if (!isLoaded) return <LoadingScreen />;
	if (isSignedIn) return <Redirect href="/(tabs)" />;
	return (
		<ReadScreen>
			<Stack screenOptions={{ headerShown: false, animation: "fade" }} />
		</ReadScreen>
	);
}
