import posthog from "posthog-js";
import { env } from "@/lib/env";
import { IS_HOSTED } from "@/lib/hosted";

const POSTHOG_PROXY_PATH = "/_cdi/px";
const POSTHOG_PROPERTY_DENYLIST = ["auth", "cookie", "password", "secret"];

type PostHogClient = typeof posthog & { __loaded?: boolean };

export function normalizePostHogToken(token: string | undefined): string | null {
	if (typeof token !== "string") return null;
	const cleaned = token.trim();
	return cleaned.length > 0 ? cleaned : null;
}

export function isHostedPostHogEnabled({
	isHosted = IS_HOSTED,
	token = env.NEXT_PUBLIC_POSTHOG_TOKEN,
}: {
	isHosted?: boolean;
	token?: string;
} = {}): boolean {
	return isHosted && normalizePostHogToken(token) !== null;
}

export function initHostedPostHog({
	isHosted = IS_HOSTED,
	token = env.NEXT_PUBLIC_POSTHOG_TOKEN,
}: {
	isHosted?: boolean;
	token?: string;
} = {}): boolean {
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
	return true;
}
