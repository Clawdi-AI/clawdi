"use client";

import { useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCurrentUser } from "@/lib/auth-client";
import {
	browserChatwootSdkScriptHost,
	browserChatwootSessionStore,
	createChatwootSessionController,
	getChatwootIdentityGeneration,
	hasChatwootIdentityFailure,
	loadChatwootSdkScript,
	markChatwootIdentityFailure,
	resolveChatwootIdentity,
	type SignedChatwootIdentity,
	setChatwootBubbleVisibility,
	shouldHideChatwoot,
	startChatwoot,
	watchChatwootIdentityStorage,
} from "@/lib/chatwoot";
import { getChatwootIdentifierHash } from "@/lib/chatwoot.functions";
import { env } from "@/lib/env";

export function ChatwootClient() {
	const { isLoaded, isSignedIn, user } = useCurrentUser();
	const pathname = useLocation({ select: (location) => location.pathname });
	const hidden = shouldHideChatwoot(pathname);
	const websiteToken = env.VITE_CHATWOOT_WEBSITE_TOKEN ?? "";
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
	const currentUserId = identity?.id ?? null;
	const [loadSdk, setLoadSdk] = useState(false);
	const [identityFailed, setIdentityFailed] = useState(
		() =>
			typeof window !== "undefined" &&
			Boolean(websiteToken) &&
			hasChatwootIdentityFailure(websiteToken, window.sessionStorage),
	);
	const [signedIdentity, setSignedIdentity] = useState<SignedChatwootIdentity | null>(null);
	const signedIdentityRef = useRef<SignedChatwootIdentity | null>(null);
	const authLoadedRef = useRef(isLoaded);
	const currentUserIdRef = useRef(currentUserId);
	const hiddenRef = useRef(hidden);
	const sdkStartedRef = useRef(false);
	authLoadedRef.current = isLoaded;
	currentUserIdRef.current = currentUserId;
	hiddenRef.current = hidden;

	const controller = useMemo(
		() =>
			createChatwootSessionController({
				websiteToken,
				readApi: () => window.$chatwoot,
				store: browserChatwootSessionStore,
				reload: () => window.location.reload(),
			}),
		[websiteToken],
	);

	const syncReadyIdentity = useCallback(() => {
		if (!authLoadedRef.current) return;
		controller.sync(signedIdentityRef.current, currentUserIdRef.current, hiddenRef.current);
	}, [controller]);

	useEffect(() => {
		const handleIdentityError = () => {
			if (websiteToken) markChatwootIdentityFailure(websiteToken, window.sessionStorage);
			setIdentityFailed(true);
			controller.failClosed();
		};
		const unwatchIdentityStorage = watchChatwootIdentityStorage(
			window,
			websiteToken,
			syncReadyIdentity,
		);
		window.addEventListener("chatwoot:ready", syncReadyIdentity);
		window.addEventListener("chatwoot:error", handleIdentityError);
		if (window.$chatwoot?.hasLoaded) syncReadyIdentity();
		return () => {
			unwatchIdentityStorage();
			window.removeEventListener("chatwoot:ready", syncReadyIdentity);
			window.removeEventListener("chatwoot:error", handleIdentityError);
		};
	}, [controller, syncReadyIdentity, websiteToken]);

	useEffect(() => {
		let active = true;
		signedIdentityRef.current = null;
		setSignedIdentity(null);
		if (!isLoaded || env.VITE_DEV_AUTH_BYPASS) return;

		if (controller.needsSdk(currentUserId)) {
			setLoadSdk(true);
			if (window.$chatwoot?.hasLoaded) controller.sync(null, currentUserId, hiddenRef.current);
			return;
		}
		if (!identity) return;
		const identityGeneration = getChatwootIdentityGeneration();

		void getChatwootIdentifierHash()
			.then((result) => {
				const identifierHash = result?.identifierHash.trim();
				if (!active || !identifierHash || getChatwootIdentityGeneration() !== identityGeneration)
					return;
				const nextIdentity = { ...identity, identifierHash };
				signedIdentityRef.current = nextIdentity;
				setSignedIdentity(nextIdentity);
				setLoadSdk(true);
			})
			.catch(() => {});

		return () => {
			active = false;
		};
	}, [controller, currentUserId, identity, isLoaded]);

	useEffect(() => {
		if (!signedIdentity) return;
		const result = controller.sync(signedIdentity, signedIdentity.id, hidden);
		if (result === "identified") {
			setChatwootBubbleVisibility(window.$chatwoot, hidden);
		}
	}, [controller, hidden, signedIdentity]);

	const startSdk = useCallback(() => {
		if (sdkStartedRef.current) return;
		sdkStartedRef.current = startChatwoot(window, {
			baseUrl: env.VITE_CHATWOOT_BASE_URL ?? "",
			websiteToken,
		});
	}, [websiteToken]);

	useEffect(() => {
		if (!loadSdk || identityFailed) return;
		loadChatwootSdkScript(browserChatwootSdkScriptHost, {
			baseUrl: env.VITE_CHATWOOT_BASE_URL ?? "",
			nonce: document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content,
			onLoad: startSdk,
		});
	}, [identityFailed, loadSdk, startSdk]);

	return null;
}
