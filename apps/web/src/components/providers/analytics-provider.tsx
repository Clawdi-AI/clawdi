"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import {
	buildHostedPersonProperties,
	resolveHostedAuthIdentityAction,
} from "@/components/providers/analytics-provider.logic";
import { IS_HOSTED } from "@/lib/hosted";

const loadHostedPostHog = IS_HOSTED ? () => import("@/hosted/posthog") : null;

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
	const { isSignedIn, userId } = useAuth();
	const { user, isLoaded: isUserLoaded } = useUser();
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

	return <>{children}</>;
}
