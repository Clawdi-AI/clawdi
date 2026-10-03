import { publicSessionId } from "@clawdi/shared/api";
import { useAuth } from "@clerk/expo";
import { Redirect, Stack, useGlobalSearchParams } from "expo-router";
import { LoadingScreen } from "../../src/ui/feedback";
import { ReadScreen } from "../../src/ui/read-screen";

export default function AuthLayout() {
	const { isLoaded, isSignedIn } = useAuth();
	const params = useGlobalSearchParams<{ publicShareId?: string }>();
	const returnShare =
		typeof params.publicShareId === "string" ? publicSessionId(params.publicShareId) : null;
	if (!isLoaded) return <LoadingScreen />;
	if (isSignedIn)
		return (
			<Redirect
				href={
					returnShare ? { pathname: "/s/[shareId]", params: { shareId: returnShare } } : "/(tabs)"
				}
			/>
		);
	return (
		<ReadScreen>
			<Stack screenOptions={{ headerShown: false, animation: "fade" }} />
		</ReadScreen>
	);
}
