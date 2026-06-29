import posthog from "posthog-js";

const POSTHOG_PROXY_PATH = "/_cdi/px";
const POSTHOG_PROPERTY_DENYLIST = ["auth", "cookie", "password", "secret"];
const HOSTED_BUILD_FLAG = import.meta.env.VITE_CLAWDI_HOSTED === "true";
const DEFAULT_POSTHOG_TOKEN = import.meta.env.VITE_POSTHOG_TOKEN;

type PostHogClient = typeof posthog & { __loaded?: boolean };
type HostedPostHogOptions = {
	isHosted?: boolean;
	token?: string;
};

export type HostedUserPersonProperties = {
	clerk_id: string;
	email?: string;
	name?: string;
};

export function normalizePostHogToken(token: string | undefined): string | null {
	if (typeof token !== "string") return null;
	const cleaned = token.trim();
	return cleaned.length > 0 ? cleaned : null;
}

export function isHostedPostHogEnabled({
	isHosted = HOSTED_BUILD_FLAG,
	token = DEFAULT_POSTHOG_TOKEN,
}: {
	isHosted?: boolean;
	token?: string;
} = {}): boolean {
	return isHosted && normalizePostHogToken(token) !== null;
}

export function initHostedPostHog({
	isHosted = HOSTED_BUILD_FLAG,
	token = DEFAULT_POSTHOG_TOKEN,
}: HostedPostHogOptions = {}): boolean {
	const normalizedToken = normalizePostHogToken(token);
	if (!isHosted || !normalizedToken) return false;

	const sdk = posthog as PostHogClient;
	if (sdk.__loaded) return false;

	posthog.init(normalizedToken, {
		api_host: POSTHOG_PROXY_PATH,
		defaults: "2026-01-30",
		person_profiles: "identified_only",
		capture_pageview: "history_change",
		capture_pageleave: true,
		autocapture: true,
		property_denylist: POSTHOG_PROPERTY_DENYLIST,
	});
	sdk.__loaded = true;
	return true;
}

export function identifyHostedUser(
	userId: string,
	{ isHosted = HOSTED_BUILD_FLAG, token = DEFAULT_POSTHOG_TOKEN }: HostedPostHogOptions = {},
): boolean {
	if (!isHostedPostHogEnabled({ isHosted, token })) return false;
	const distinctId = userId.trim();
	if (distinctId.length === 0) return false;

	posthog.identify(distinctId, { clerk_id: distinctId });
	return true;
}

export function resetHostedPostHog({
	isHosted = HOSTED_BUILD_FLAG,
	token = DEFAULT_POSTHOG_TOKEN,
}: HostedPostHogOptions = {}): boolean {
	if (!isHostedPostHogEnabled({ isHosted, token })) return false;
	posthog.reset();
	return true;
}

export function enrichHostedUser(
	personProperties: HostedUserPersonProperties,
	{ isHosted = HOSTED_BUILD_FLAG, token = DEFAULT_POSTHOG_TOKEN }: HostedPostHogOptions = {},
): boolean {
	if (!isHostedPostHogEnabled({ isHosted, token })) return false;
	posthog.setPersonProperties(personProperties);
	return true;
}
