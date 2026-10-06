import { publicSessionId } from "@clawdi/shared/api";
import { Redirect, Stack, useGlobalSearchParams } from "expo-router";
import { LoadingScreen } from "@/components/ui/feedback";
import { useAppAuth } from "@/platform/auth/auth-client";
import { ClerkOnly } from "@/platform/auth/clerk-only";
import { ReadScreen } from "@/platform/safe-area-screen";

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
			<Redirect href={returnShare ? { pathname: "/s/[id]", params: { id: returnShare } } : "/"} />
		);
	return (
		<ReadScreen>
			<Stack screenOptions={{ headerShown: false, animation: "fade" }} />
		</ReadScreen>
	);
}
