"use client";

import * as Sentry from "@sentry/tanstackstart-react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useCurrentUser } from "@/lib/auth-client";
import { CHATWOOT_SETTINGS, resolveChatwootIdentity, shouldHideChatwoot } from "@/lib/chatwoot";
import { getChatwootIdentifierHash } from "@/lib/chatwoot.functions";
import { env } from "@/lib/env";

const SCRIPT_ID = "chatwoot-sdk";
const BASE_URL = env.VITE_CHATWOOT_BASE_URL?.replace(/\/+$/, "") ?? "";
const WEBSITE_TOKEN = env.VITE_CHATWOOT_WEBSITE_TOKEN ?? "";

export function ChatwootClient() {
	const { isLoaded, isSignedIn, user } = useCurrentUser();
	const pathname = useLocation({ select: (location) => location.pathname });
	const hidden = shouldHideChatwoot(pathname);
	const userId = user?.id;
	const userName = user?.fullName ?? null;
	const userEmail = user?.primaryEmailAddress?.emailAddress;
	const identity = useMemo(
		() =>
			isLoaded && isSignedIn && userId
				? resolveChatwootIdentity({
						id: userId,
						fullName: userName,
						primaryEmailAddress: userEmail ? { emailAddress: userEmail } : null,
					})
				: null,
		[isLoaded, isSignedIn, userEmail, userId, userName],
	);
	const [ready, setReady] = useState(false);
	const [identifiedUserId, setIdentifiedUserId] = useState<string | null>(null);
	// Dev auth bypass has no Clerk session for the server-side identity hash.
	const signedIn = identity !== null && !env.VITE_DEV_AUTH_BYPASS;

	// Chatwoot's install snippet, loaded only once a user has signed in.
	useEffect(() => {
		if (!signedIn || !BASE_URL || !WEBSITE_TOKEN || document.getElementById(SCRIPT_ID)) return;
		window.chatwootSettings = CHATWOOT_SETTINGS;
		const script = document.createElement("script");
		script.id = SCRIPT_ID;
		script.src = `${BASE_URL}/packs/js/sdk.js`;
		script.async = true;
		script.nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "";
		script.onload = () => {
			window.chatwootSDK?.run({ websiteToken: WEBSITE_TOKEN, baseUrl: BASE_URL });
		};
		document.body.appendChild(script);
	}, [signedIn]);

	useEffect(() => {
		const markReady = () => setReady(true);
		if (window.$chatwoot?.hasLoaded) markReady();
		window.addEventListener("chatwoot:ready", markReady);
		return () => window.removeEventListener("chatwoot:ready", markReady);
	}, []);

	// Identity validation: the identifier hash is computed server-side for the Clerk user.
	useEffect(() => {
		if (!ready || !signedIn || !identity) return;
		let active = true;
		getChatwootIdentifierHash()
			.then((result) => {
				if (!active || !result) return;
				window.$chatwoot?.setUser(identity.id, {
					name: identity.name,
					email: identity.email,
					identifier_hash: result.identifierHash,
				});
				setIdentifiedUserId(identity.id);
			})
			.catch((error: unknown) => Sentry.captureException(error));
		return () => {
			active = false;
		};
	}, [identity, ready, signedIn]);

	const showBubble = ready && identity !== null && identifiedUserId === identity.id && !hidden;
	useEffect(() => {
		const chatwoot = window.$chatwoot;
		if (!ready || !chatwoot) return;
		if (!showBubble) chatwoot.toggle("close");
		chatwoot.toggleBubbleVisibility(showBubble ? "show" : "hide");
	}, [ready, showBubble]);

	return null;
}
