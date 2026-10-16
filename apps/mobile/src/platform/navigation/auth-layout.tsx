import { publicSessionId } from "@clawdi/shared/api";
import { resolveDeployChannel } from "@clawdi/shared/view";
import { useAuthViewState } from "@clerk/expo/native-components";
import { Redirect, Stack, useGlobalSearchParams } from "expo-router";
import { routeSearch } from "@/lib/route-params";
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
	const channel = resolveDeployChannel(routeSearch(params));
	if (isSignedIn && isAuthFlowComplete)
		return (
			<Redirect
				href={
					returnShare
						? { pathname: "/s/[id]", params: { id: returnShare } }
						: channel
							? { pathname: "/deploy", params: { deploy_profile: channel } }
							: "/"
				}
			/>
		);
	return <Stack screenOptions={{ headerShown: false, animation: "fade" }} />;
}
