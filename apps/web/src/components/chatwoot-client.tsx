"use client";

import * as Sentry from "@sentry/tanstackstart-react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { useCurrentUser } from "@/lib/auth-client";
import { CHATWOOT_SETTINGS, resolveChatwootIdentity, shouldHideChatwoot } from "@/lib/chatwoot";
import { getChatwootIdentifierHash } from "@/lib/chatwoot.functions";
import { env } from "@/lib/env";

const SCRIPT_ID = "chatwoot-sdk";
const BASE_URL = env.VITE_CHATWOOT_BASE_URL?.replace(/\/+$/, "") ?? "";
const WEBSITE_TOKEN = env.VITE_CHATWOOT_WEBSITE_TOKEN ?? "";

export function ChatwootClient() {
	const { isLoaded, isSignedIn, user } = useCurrentUser();
	const { resolvedTheme } = useTheme();
	const pathname = useLocation({ select: (location) => location.pathname });
	const hidden = shouldHideChatwoot(pathname);
	const userId = user?.id;
	const userName = user?.fullName ?? null;
	const userEmail = user?.primaryEmailAddress?.emailAddress;
	const userImageUrl = user?.imageUrl ?? "";
	const identity = useMemo(
		() =>
			isLoaded && isSignedIn && userId
				? resolveChatwootIdentity({
						id: userId,
						fullName: userName,
						primaryEmailAddress: userEmail ? { emailAddress: userEmail } : null,
						imageUrl: userImageUrl,
					})
				: null,
		[isLoaded, isSignedIn, userEmail, userId, userImageUrl, userName],
	);
	const [ready, setReady] = useState(false);
	const [identifiedUserId, setIdentifiedUserId] = useState<string | null>(null);
	// Dev auth bypass has no Clerk session for the server-side identity hash.
	const enabled = identity !== null && !env.VITE_DEV_AUTH_BYPASS;

	useEffect(() => {
		window.chatwootSettings = { ...CHATWOOT_SETTINGS, darkMode: resolvedTheme };
		const chatwoot = window.$chatwoot;
		if (!ready || !chatwoot) return;
		try {
			// The SDK reuses darkMode when reset() reloads the widget iframe.
			chatwoot.darkMode = resolvedTheme;
			chatwoot.setColorScheme(resolvedTheme);
		} catch (error: unknown) {
			Sentry.captureException(error);
		}
	}, [ready, resolvedTheme]);

	// Chatwoot's install snippet, loaded only once a user has signed in.
	useEffect(() => {
		if (!enabled || !BASE_URL || !WEBSITE_TOKEN || document.getElementById(SCRIPT_ID)) return;
		const script = document.createElement("script");
		script.id = SCRIPT_ID;
		script.src = `${BASE_URL}/packs/js/sdk.js`;
		script.async = true;
		script.nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? "";
		script.onload = () => {
			window.chatwootSDK?.run({ websiteToken: WEBSITE_TOKEN, baseUrl: BASE_URL });
		};
		script.onerror = () => Sentry.captureException(new Error("Failed to load the Chatwoot SDK"));
		document.body.appendChild(script);
	}, [enabled]);

	useEffect(() => {
		const markReady = () => setReady(true);
		if (window.$chatwoot?.hasLoaded) markReady();
		window.addEventListener("chatwoot:ready", markReady);
		return () => window.removeEventListener("chatwoot:ready", markReady);
	}, []);

	// Identity validation: the identifier hash is computed server-side for the Clerk user.
	useEffect(() => {
		if (!ready || !enabled || !identity) return;
		let active = true;
		getChatwootIdentifierHash()
			.then((result) => {
				if (!active || !result) return;
				window.$chatwoot?.setUser(identity.id, {
					name: identity.name,
					email: identity.email,
					...(identity.avatarUrl ? { avatar_url: identity.avatarUrl } : {}),
					identifier_hash: result.identifierHash,
				});
				setIdentifiedUserId(identity.id);
			})
			.catch((error: unknown) => Sentry.captureException(error));
		return () => {
			active = false;
		};
	}, [enabled, identity, ready]);

	const showBubble =
		ready && enabled && identity !== null && identifiedUserId === identity.id && !hidden;
	useEffect(() => {
		const chatwoot = window.$chatwoot;
		if (!ready || !chatwoot) return;
		if (!showBubble) chatwoot.toggle("close");
		chatwoot.toggleBubbleVisibility(showBubble ? "show" : "hide");
	}, [ready, showBubble]);

	return null;
}
