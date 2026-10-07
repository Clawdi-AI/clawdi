"use client";

import { useLocation } from "@tanstack/react-router";
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
	const pathname = useLocation({ select: (location) => location.pathname });
	const identifiedUserIdRef = useRef<string | null>(null);
	const lastView = useRef<string | null>(null);

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
			if (!sdk.canCaptureProductEvents() || document.visibilityState === "hidden") return;
			const viewKey = `${userId ?? "anonymous"}:${pathname}:${new Date().toISOString().slice(0, 10)}`;
			if (lastView.current === viewKey) return;
			const source = window.clawdiDesktop ? "desktop" : "web";
			let captured = false;
			if (!isSignedIn && (pathname.startsWith("/sign-up") || pathname.startsWith("/sign-in"))) {
				captured = sdk.trackEvent(
					{
						name: pathname.startsWith("/sign-up") ? "signup_viewed" : "signin_viewed",
						properties: sdk.acquisitionProperties(window.location.search, document.referrer),
					},
					source,
				);
			} else if (isSignedIn) {
				const feature = sdk.featureForPath(pathname);
				if (pathname === "/deploy")
					captured = sdk.trackEvent(
						{ name: "onboarding_viewed", properties: { step: "deployed" } },
						source,
					);
				else if (feature)
					captured = sdk.trackEvent({ name: "product_viewed", properties: { feature } }, source);
			}
			if (captured) lastView.current = viewKey;
		};
		const capture = () => {
			void report().catch(() => {
				/* Analytics must not interrupt navigation. */
			});
		};
		capture();
		window.addEventListener("focus", capture);
		document.addEventListener("visibilitychange", capture);
		return () => {
			cancelled = true;
			window.removeEventListener("focus", capture);
			document.removeEventListener("visibilitychange", capture);
		};
	}, [isSignedIn, userId, pathname]);
	return null;
}
