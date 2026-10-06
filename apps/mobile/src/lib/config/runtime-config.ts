import { readApiBaseUrl } from "@clawdi/shared/api";
import { readLinkHosts } from "@clawdi/shared/linking";
import type { OAuthProvider } from "@clerk/expo/types";
import { readOAuthProviders } from "@/platform/auth/oauth-providers";

export type MobileRuntimeConfig = Readonly<{
	cloudApiUrl: string;
	clerkPublishableKey: string;
	computeApiUrl?: string;
	revenueCatAppleKey?: string;
	revenueCatGoogleKey?: string;
	clerkOauthProviders?: readonly OAuthProvider[];
	linkHosts?: readonly string[];
}>;

export type MobileRuntimeConfigResult =
	| { ok: true; value: MobileRuntimeConfig }
	| { ok: false; reason: "missing" | "invalid" };

type RuntimeConfigValues = Readonly<{
	cloudApiUrl: unknown;
	clerkPublishableKey: unknown;
	computeApiUrl?: unknown;
	revenueCatAppleKey?: unknown;
	revenueCatGoogleKey?: unknown;
	clerkOauthProviders?: unknown;
	linkHosts?: unknown;
}>;

function requiredString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const clerkPublishableKeyPattern = /^pk_(?:test|live)_[A-Za-z0-9_-]+$/;

export function parseMobileRuntimeConfig(
	values: RuntimeConfigValues,
	{ requireClerk = true }: { requireClerk?: boolean } = {},
): MobileRuntimeConfigResult {
	const cloudApiUrl = requiredString(values.cloudApiUrl);
	const clerkPublishableKey = requiredString(values.clerkPublishableKey);
	const computeApiUrl = requiredString(values.computeApiUrl);
	const revenueCatAppleKey = requiredString(values.revenueCatAppleKey);
	const revenueCatGoogleKey = requiredString(values.revenueCatGoogleKey);
	if (!cloudApiUrl || (requireClerk && !clerkPublishableKey)) {
		return { ok: false, reason: "missing" };
	}
	if (clerkPublishableKey && !clerkPublishableKeyPattern.test(clerkPublishableKey))
		return { ok: false, reason: "invalid" };
	if (values.computeApiUrl != null && typeof values.computeApiUrl !== "string")
		return { ok: false, reason: "invalid" };
	try {
		const clerkOauthProviders = readOAuthProviders(values.clerkOauthProviders);
		const linkHosts = readLinkHosts(values.linkHosts);
		return {
			ok: true,
			value: {
				cloudApiUrl: readApiBaseUrl(cloudApiUrl),
				clerkPublishableKey: clerkPublishableKey ?? "",
				...(clerkOauthProviders.length ? { clerkOauthProviders } : {}),
				...(linkHosts.length ? { linkHosts } : {}),
				...(computeApiUrl ? { computeApiUrl: readApiBaseUrl(computeApiUrl, true) } : {}),
				...(revenueCatAppleKey ? { revenueCatAppleKey } : {}),
				...(revenueCatGoogleKey ? { revenueCatGoogleKey } : {}),
			},
		};
	} catch {
		return { ok: false, reason: "invalid" };
	}
}
