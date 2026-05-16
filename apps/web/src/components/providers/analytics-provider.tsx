"use client";

import { useEffect, useRef, useState } from "react";
import {
	buildHostedPersonProperties,
	resolveHostedAuthIdentityAction,
} from "@/components/providers/analytics-provider.logic";
import { useCurrentUser, useDashboardAuth } from "@/lib/auth-client";
import { IS_HOSTED } from "@/lib/hosted";

const loadHostedPostHog = IS_HOSTED ? () => import("@/hosted/posthog") : null;

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
	return (
		<>
			{children}
			{loadHostedPostHog ? <HostedAnalyticsClient /> : null}
		</>
	);
}

function HostedAnalyticsClient() {
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	if (!mounted) return null;
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

		if (!loadHostedPostHog) return;
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
		if (!personProperties || !loadHostedPostHog) return;

		void loadHostedPostHog().then((mod) => {
			mod.enrichHostedUser(personProperties);
		});
	}, [isSignedIn, userId, userLoaded, userEmail, userFullName]);

	return null;
}
