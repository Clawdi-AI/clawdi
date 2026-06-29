"use client";

import { useEffect, useRef, useState } from "react";
import {
	buildHostedPersonProperties,
	resolveHostedAuthIdentityAction,
} from "@/components/providers/analytics-provider.logic";
import { useCurrentUser, useDashboardAuth } from "@/lib/auth-client";

const loadHostedPostHog = () => import("@/hosted/posthog");

export function HostedAnalyticsClient() {
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	if (!mounted) return <span data-hosted="true" hidden aria-hidden="true" />;
	return <HostedAnalyticsIdentity />;
}

function HostedAnalyticsIdentity() {
	const { isSignedIn, userId } = useDashboardAuth();
	const { user, isLoaded: isUserLoaded } = useCurrentUser();
	const identifiedUserIdRef = useRef<string | null>(null);

	useEffect(() => {
		const transition = resolveHostedAuthIdentityAction({
			isSignedIn: Boolean(isSignedIn),
			userId,
			lastIdentifiedUserId: identifiedUserIdRef.current,
		});
		identifiedUserIdRef.current = transition.nextIdentifiedUserId;

		if (transition.action.type === "identify") {
			const identifyUserId = transition.action.userId;
			void loadHostedPostHog().then((mod) => {
				mod.identifyHostedUser(identifyUserId);
			});
			return;
		}
		if (transition.action.type === "reset") {
			void loadHostedPostHog().then((mod) => {
				mod.resetHostedPostHog();
			});
		}
	}, [isSignedIn, userId]);

	const userEmail = user?.primaryEmailAddress?.emailAddress ?? null;
	const userFullName = user?.fullName ?? null;
	const userLoaded = isUserLoaded && user !== null;

	useEffect(() => {
		const personProperties = buildHostedPersonProperties({
			isSignedIn: Boolean(isSignedIn),
			userId,
			user: userLoaded
				? {
						fullName: userFullName,
						primaryEmailAddress: userEmail ? { emailAddress: userEmail } : null,
					}
				: null,
		});
		if (!personProperties) return;

		void loadHostedPostHog().then((mod) => {
			mod.enrichHostedUser(personProperties);
		});
	}, [isSignedIn, userId, userLoaded, userEmail, userFullName]);

	return <span data-hosted="true" hidden aria-hidden="true" />;
}
