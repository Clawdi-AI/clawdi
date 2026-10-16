import { agentSectionCopy, resolveDeployChannel } from "@clawdi/shared/view";
import { Redirect, Stack, useGlobalSearchParams, usePathname } from "expo-router";
import { LoadingScreen } from "@/components/ui/feedback";
import { useI18n } from "@/lib/i18n";
import { routeSearch } from "@/lib/route-params";
import { useAppAuth } from "@/platform/auth/auth-client";

import { useNativeStackOptions } from "@/platform/navigation/native-header";

export function SignedInLayout() {
	const t = useI18n();
	const roots: Record<string, string> = {
		index: t("navigation.home"),
		"agents/index": t("navigation.agents"),
		"sessions/index": t("navigation.sessions"),
		library: t("navigation.library"),
		"channels/index": t("channels.title"),
		"ai-providers/index": agentSectionCopy.ai.label,
		"settings/index": t("settingsParity.title"),
	};

	const options = useNativeStackOptions();
	const { isLoaded, isSignedIn } = useAppAuth();
	if (!isLoaded) return <LoadingScreen label={t("loading.authentication")} />;
	if (!isSignedIn) return <SignInRedirect />;
	return (
		<Stack
			screenOptions={({ route }) => ({
				...options,
				// Unknown titles stay empty until the page sets its own; never show route names.
				title: roots[route.name] ?? "",
				headerLargeTitleEnabled: route.name in roots,
			})}
		/>
	);
}

/**
 * Like Web's sign-in return URL, a deploy channel link survives signing in. Only this signed-out
 * redirect reads route params, so signed-in stacks never subscribe to them.
 */
function SignInRedirect() {
	const pathname = usePathname();
	const search = routeSearch(useGlobalSearchParams());
	const channel = pathname === "/deploy" ? resolveDeployChannel(search) : null;
	return (
		<Redirect
			href={
				channel
					? { pathname: "/sign-in", params: { redirect_url: `/deploy?deploy_profile=${channel}` } }
					: "/sign-in"
			}
		/>
	);
}
