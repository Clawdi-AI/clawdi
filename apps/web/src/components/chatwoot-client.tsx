"use client";

import { useEffect, useMemo } from "react";
import { useCurrentUser } from "@/lib/auth-client";
import { chatwootWidgetController, resolveChatwootWidgetRequest } from "@/lib/chatwoot";
import { getChatwootIdentifierHash } from "@/lib/chatwoot.functions";
import { env } from "@/lib/env";

export function ChatwootClient() {
	const { isLoaded, isSignedIn, user } = useCurrentUser();
	const userId = user?.id;
	const userName = user?.fullName;
	const userEmail = user?.primaryEmailAddress?.emailAddress;
	const request = useMemo(
		() =>
			resolveChatwootWidgetRequest({
				baseUrl: env.VITE_CHATWOOT_BASE_URL,
				websiteToken: env.VITE_CHATWOOT_WEBSITE_TOKEN,
				desktopBuild: env.VITE_CLAWDI_DESKTOP_BUILD,
				isLoaded,
				isSignedIn,
				user: userId
					? {
							id: userId,
							fullName: userName ?? null,
							primaryEmailAddress: userEmail ? { emailAddress: userEmail } : null,
						}
					: null,
			}),
		[isLoaded, isSignedIn, userEmail, userId, userName],
	);

	useEffect(() => {
		if (!request || env.VITE_DEV_AUTH_BYPASS) return;
		void chatwootWidgetController.start(request, async () => {
			const result = await getChatwootIdentifierHash();
			return result?.identifierHash ?? null;
		});
		return () => chatwootWidgetController.cancel();
	}, [request]);

	return null;
}
