"use client";

import { useEffect, useRef, useState } from "react";
import { useHostedProductAccessProfileQuery } from "@/hosted/access/product-access";
import {
	buildHostedPersonProperties,
	resolveHostedAuthIdentityAction,
} from "@/hosted/analytics-identity.logic";
import {
	buildMavaIdentity,
	createMavaIdentityController,
	type MavaIdentityController,
	startMavaIdentitySync,
} from "@/hosted/mava";
import "@/hosted/mava.css";
import { useCurrentUser, useDashboardAuth } from "@/lib/auth-client";

const loadHostedPostHog = () => import("@/hosted/posthog");
const loadHostedCustomerIO = () => import("@/hosted/customerio");

export function HostedAnalyticsClient() {
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
	const hostedProfile = useHostedProductAccessProfileQuery();
	const identifiedUserIdRef = useRef<string | null>(null);
	const mavaControllerRef = useRef<MavaIdentityController | null>(null);
	if (mavaControllerRef.current === null) {
		mavaControllerRef.current = createMavaIdentityController();
	}
	const mavaController = mavaControllerRef.current;

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

	const customerId = hostedProfile.data?.id ?? null;
	useEffect(() => {
		let active = true;
		void loadHostedCustomerIO()
			.then((mod) => {
				if (!active) return;
				return mod.syncHostedCustomerIOIdentity(
					isSignedIn && mod.isCanonicalHostedCustomerId(customerId) ? { customerId } : null,
				);
			})
			.catch(() => console.warn("Customer.io identity sync failed"));
		return () => {
			active = false;
		};
	}, [customerId, isSignedIn]);

	useEffect(() => {
		if (!isSignedIn || !userLoaded) return;
		const identity = buildMavaIdentity({
			userId,
			emailAddress: userEmail,
			fullName: userFullName,
		});
		if (!identity) return;

		return startMavaIdentitySync({ controller: mavaController, identity });
	}, [isSignedIn, mavaController, userEmail, userFullName, userId, userLoaded]);

	return null;
}
