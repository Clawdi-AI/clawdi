import { publicSessionId } from "@clawdi/shared/api";
import { Redirect, Stack, useGlobalSearchParams } from "expo-router";
import { LoadingScreen } from "@/components/ui/feedback";
import { useAppAuth } from "@/platform/auth/auth-client";
import { ClerkOnly } from "@/platform/auth/clerk-only";
import { useNativeStackOptions } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

export default function AuthLayout() {
	return (
		<ClerkOnly>
			<ClerkAuthLayout />
		</ClerkOnly>
	);
}

function ClerkAuthLayout() {
	const options = useNativeStackOptions();
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
		<SafeAreaScreen>
			<Stack screenOptions={{ ...options, animation: "fade" }} />
		</SafeAreaScreen>
	);
}
