"use client";

import { useEffect, useRef, useState } from "react";
import { resolveHostedAuthIdentityAction } from "@/hosted/analytics-identity.logic";
import { useDashboardAuth } from "@/lib/auth-client";

const loadHostedPostHog = () => import("@/hosted/posthog");

export function HostedAnalyticsClient() {
	const [mounted, setMounted] = useState(false);
	useEffect(() => {
		setMounted(true);
	}, []);
	return mounted ? <HostedAnalyticsIdentity /> : null;
}

function HostedAnalyticsIdentity() {
	const { isSignedIn, userId } = useDashboardAuth();
	const identifiedUserIdRef = useRef<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const report = async () => {
			const sdk = await loadHostedPostHog();
			if (cancelled) return;
			const transition = resolveHostedAuthIdentityAction({
				isSignedIn: Boolean(isSignedIn),
				userId,
				lastIdentifiedUserId: identifiedUserIdRef.current,
			});
			if (transition.action.type === "identify") sdk.identifyHostedUser(transition.action.userId);
			if (transition.action.type === "reset") sdk.resetHostedPostHog();
			identifiedUserIdRef.current = transition.nextIdentifiedUserId;
		};
		const capture = () => {
			void report().catch(() => {
				/* Analytics must not interrupt navigation. */
			});
		};
		capture();
		return () => {
			cancelled = true;
		};
	}, [isSignedIn, userId]);
	return null;
}
