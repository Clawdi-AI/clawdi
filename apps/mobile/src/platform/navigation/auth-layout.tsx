import { publicSessionId } from "@clawdi/shared/api";
import { useAuthViewState } from "@clerk/expo/native";
import { Redirect, Stack, useGlobalSearchParams } from "expo-router";
import { useAppAuth } from "@/platform/auth/auth-client";
import { ClerkOnly } from "@/platform/auth/clerk-only";

export default function AuthLayout() {
	return (
		<ClerkOnly>
			<ClerkAuthLayout />
		</ClerkOnly>
	);
}

/**
 * Keeps Clerk's AuthView mounted until the native flow (session tasks, biometric
 * enrollment) finishes and the session is active; AuthView never navigates itself.
 */
function ClerkAuthLayout() {
	const { isSignedIn } = useAppAuth();
	const { isAuthFlowComplete } = useAuthViewState();
	const params = useGlobalSearchParams<{ publicShareId?: string }>();
	const returnShare =
		typeof params.publicShareId === "string" ? publicSessionId(params.publicShareId) : null;
	if (isSignedIn && isAuthFlowComplete)
		return (
			<Redirect href={returnShare ? { pathname: "/s/[id]", params: { id: returnShare } } : "/"} />
		);
	return <Stack screenOptions={{ headerShown: false, animation: "fade" }} />;
}
