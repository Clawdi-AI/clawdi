import posthog from "posthog-js";
import { isOverviewPath } from "@/lib/navigation-model";

const POSTHOG_PROXY_PATH = "/_cdi/px";
const POSTHOG_PROPERTY_DENYLIST = ["auth", "cookie", "password", "secret"];
const SAFE_PROPERTY_KEYS = new Set([
	"distinct_id",
	"$anon_distinct_id",
	"$device_id",
	"$user_id",
	"$session_id",
	"$window_id",
	"$host",
	"$lib",
	"$lib_version",
	"$insert_id",
	"$is_identified",
	"$process_person_profile",
	"source",
	"schema_version",
	"feature",
	"acquisition_source",
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"referrer",
]);

export function safeEventProperties(
	properties: Record<string, unknown>,
	eventName: string,
	pathname: string,
): Record<string, unknown> {
	const safe = Object.fromEntries(
		Object.entries(properties).filter(([key]) => SAFE_PROPERTY_KEYS.has(key)),
	);
	// Automatic SDK pageviews can carry raw campaign values from the URL.
	// Validate those values at the final boundary as well as in trackEvent.
	const bounded: Record<string, readonly string[]> = {
		feature: PRODUCT_FEATURES,
		source: ["web"],
		acquisition_source: ["direct", "other", ...ACQUISITION_SOURCES],
		utm_source: ["direct", "other", ...ACQUISITION_SOURCES],
		referrer: ["direct", "other", ...ACQUISITION_SOURCES],
		utm_medium: ["none", "organic", "cpc", "social", "email", "referral", "other"],
		utm_campaign: ["none", "launch", "onboarding", "newsletter", "other"],
	};
	for (const [key, values] of Object.entries(bounded)) {
		if (!(key in safe)) continue;
		const value = safe[key];
		if (typeof value !== "string" || !values.includes(value)) {
			if (key.startsWith("utm_") || key === "referrer" || key === "acquisition_source")
				safe[key] = "other";
			else delete safe[key];
		}
	}
	if (safe.schema_version !== 1) delete safe.schema_version;
	if (typeof safe.$process_person_profile !== "boolean") delete safe.$process_person_profile;
	if (eventName === "$pageview") safe.feature = featureForPath(pathname);
	// Keep only the hostname. URLs, credentials, ports, query strings and paths
	// must never travel in the SDK's host property.
	if ("$host" in safe) {
		const host = safe.$host;
		try {
			if (typeof host !== "string" || new URL(`https://${host}`).hostname !== host)
				delete safe.$host;
		} catch {
			delete safe.$host;
		}
	}
	const person = properties.$set;
	if (
		person &&
		typeof person === "object" &&
		"clerk_id" in person &&
		typeof person.clerk_id === "string"
	) {
		safe.$set = { clerk_id: person.clerk_id };
	}
	return safe;
}
const HOSTED_BUILD_FLAG = import.meta.env.VITE_CLAWDI_HOSTED === "true";
const DEFAULT_POSTHOG_TOKEN = import.meta.env.VITE_POSTHOG_TOKEN;

type PostHogClient = typeof posthog & { __loaded?: boolean };
type HostedPostHogOptions = {
	isHosted?: boolean;
	token?: string;
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
	return (
		isHosted &&
		normalizePostHogToken(token) !== null &&
		typeof window !== "undefined" &&
		window.location.protocol === "https:" &&
		window.location.hostname === "cloud.clawdi.ai"
	);
}

export function initHostedPostHog({
	isHosted = HOSTED_BUILD_FLAG,
	token = DEFAULT_POSTHOG_TOKEN,
}: HostedPostHogOptions = {}): boolean {
	const normalizedToken = normalizePostHogToken(token);
	if (!isHostedPostHogEnabled({ isHosted, token }) || !normalizedToken) return false;

	const sdk = posthog as PostHogClient;
	if (sdk.__loaded) return false;

	posthog.init(normalizedToken, {
		api_host: POSTHOG_PROXY_PATH,
		defaults: "2026-01-30",
		person_profiles: "identified_only",
		capture_pageview: "history_change",
		capture_pageleave: false,
		autocapture: false,
		respect_dnt: true,
		disable_session_recording: true,
		property_denylist: POSTHOG_PROPERTY_DENYLIST,
		// Run only the bundled SDK; never load remote PostHog scripts or the toolbar.
		disable_external_dependency_loading: true,
		before_send: (event) => {
			if (!isHostedPostHogEnabled({ isHosted, token })) return null;
			const url = event?.properties?.$current_url;
			if (
				(typeof window !== "undefined" && window.location.pathname === "/vault-request") ||
				(typeof url === "string" && url.includes("/vault-request"))
			)
				return null;
			if (!event) return null;
			const pathname = window.location.pathname;
			const feature = featureForPath(pathname);
			const properties = {
				...event.properties,
				source: "web",
				schema_version: 1,
				...(event.event === "$pageview" && (feature === "sign_up" || feature === "sign_in")
					? acquisitionProperties(window.location.search, document.referrer)
					: {}),
			};
			return {
				...event,
				properties: safeEventProperties(properties, event.event, pathname),
			};
		},
	});
	// Remove toolbar state left in storage by earlier sessions.
	try {
		window.localStorage.removeItem("_postHogToolbarParams");
	} catch {
		// localStorage can be unavailable (e.g. blocked storage); nothing to clear.
	}
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

const PRODUCT_FEATURES = [
	"overview",
	"sign_up",
	"sign_in",
	"deploy",
	"agents",
	"sessions",
	"skills",
	"vault",
	"files",
	"connectors",
	"channels",
	"projects",
	"sharing",
	"settings",
	"memories",
	"ai_providers",
] as const;
export type ProductFeature = (typeof PRODUCT_FEATURES)[number];
export type AcquisitionSource =
	| "direct"
	| "google"
	| "bing"
	| "github"
	| "x"
	| "linkedin"
	| "newsletter"
	| "referral"
	| "other";
export type AcquisitionProperties = {
	acquisition_source: AcquisitionSource;
	utm_source: AcquisitionSource;
	utm_medium: "none" | "organic" | "cpc" | "social" | "email" | "referral" | "other";
	utm_campaign: "none" | "launch" | "onboarding" | "newsletter" | "other";
	referrer: AcquisitionSource;
};
export type ProductEvent = { name: "agent_setup_opened"; properties: Record<string, never> };

const ACQUISITION_SOURCES: readonly AcquisitionSource[] = [
	"google",
	"bing",
	"github",
	"x",
	"linkedin",
	"newsletter",
	"referral",
];

export function acquisitionProperties(search: string, referrer: string): AcquisitionProperties {
	const params = new URLSearchParams(search);
	const value = params.get("utm_source")?.toLowerCase();
	const utmSource =
		ACQUISITION_SOURCES.find((entry) => entry === value) ?? (value ? "other" : "direct");
	let referrerSource: AcquisitionSource = "direct";
	try {
		const host = new URL(referrer).hostname.toLowerCase();
		referrerSource =
			ACQUISITION_SOURCES.find(
				(entry) => host === `${entry}.com` || host.endsWith(`.${entry}.com`),
			) ?? "other";
	} catch {
		/* Empty/invalid referrers are direct; never forward a raw URL. */
	}
	const medium = params.get("utm_medium")?.toLowerCase();
	const campaign = params.get("utm_campaign")?.toLowerCase();
	return {
		acquisition_source: value ? utmSource : referrerSource,
		utm_source: utmSource,
		referrer: referrerSource,
		utm_medium: ["organic", "cpc", "social", "email", "referral"].includes(medium ?? "")
			? (medium as AcquisitionProperties["utm_medium"])
			: medium
				? "other"
				: "none",
		utm_campaign: ["launch", "onboarding", "newsletter"].includes(campaign ?? "")
			? (campaign as AcquisitionProperties["utm_campaign"])
			: campaign
				? "other"
				: "none",
	};
}

export function featureForPath(pathname: string): ProductFeature | null {
	if (pathname === "/vault-request" || pathname.startsWith("/share/") || pathname.startsWith("/s/"))
		return null;
	if (pathname === "/sign-up" || pathname.startsWith("/sign-up/")) return "sign_up";
	if (pathname === "/sign-in" || pathname.startsWith("/sign-in/")) return "sign_in";
	if (pathname === "/deploy") return "deploy";
	if (isOverviewPath(pathname)) return "overview";
	const segments = pathname.split("/");
	for (const segment of segments.slice(1).reverse()) {
		switch (segment) {
			case "skills":
				return "skills";
			case "vault":
			case "vaults":
				return "vault";
			case "files":
				return "files";
			case "connectors":
				return "connectors";
			case "channels":
				return "channels";
			case "sharing":
				return "sharing";
			case "sessions":
				return "sessions";
			case "settings":
				return "settings";
			case "memories":
				return "memories";
			case "ai-providers":
				return "ai_providers";
		}
	}
	if (segments[1] === "agents") return "agents";
	if (segments[1] === "projects") return "projects";
	return null;
}

export function canCaptureProductEvents(options: HostedPostHogOptions = {}): boolean {
	if (!isHostedPostHogEnabled(options) || typeof window === "undefined") return false;
	if (navigator.doNotTrack === "1" || window.location.pathname === "/vault-request") return false;
	return !posthog.has_opted_out_capturing();
}

export function trackEvent(event: ProductEvent, options: HostedPostHogOptions = {}): boolean {
	try {
		if (!canCaptureProductEvents(options)) return false;
		posthog.capture(event.name, { ...event.properties, source: "web", schema_version: 1 });
		return true;
	} catch {
		return false;
	}
}
