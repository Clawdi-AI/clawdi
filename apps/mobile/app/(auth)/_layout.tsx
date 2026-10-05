import { publicSessionId } from "@clawdi/shared/api";
import { Redirect, Stack, useGlobalSearchParams } from "expo-router";
import { useAppAuth } from "../../src/auth/auth-client";
import { ClerkOnly } from "../../src/auth/clerk-only";
import { LoadingScreen } from "../../src/ui/feedback";
import { ReadScreen } from "../../src/ui/read-screen";

export default function AuthLayout() {
	return (
		<ClerkOnly>
			<ClerkAuthLayout />
		</ClerkOnly>
	);
}

function ClerkAuthLayout() {
	const { isLoaded, isSignedIn } = useAppAuth();
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
