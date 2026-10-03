import { readApiBaseUrl } from "@clawdi/shared/api";
import type { OAuthProvider } from "@clerk/expo/types";
import { readLinkHosts } from "../../config/linking.cjs";
import { readOAuthProviders } from "../auth/oauth-providers";

export type MobileRuntimeConfig = Readonly<{
	cloudApiUrl: string;
	clerkPublishableKey: string;
	computeApiUrl?: string;
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
	clerkOauthProviders?: unknown;
	linkHosts?: unknown;
}>;

function requiredString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const clerkPublishableKeyPattern = /^pk_(?:test|live)_[A-Za-z0-9_-]+$/;

export function parseMobileRuntimeConfig(values: RuntimeConfigValues): MobileRuntimeConfigResult {
	const cloudApiUrl = requiredString(values.cloudApiUrl);
	const clerkPublishableKey = requiredString(values.clerkPublishableKey);
	const computeApiUrl = requiredString(values.computeApiUrl);
	if (!cloudApiUrl || !clerkPublishableKey) {
		return { ok: false, reason: "missing" };
	}
	if (!clerkPublishableKeyPattern.test(clerkPublishableKey))
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
				clerkPublishableKey,
				...(clerkOauthProviders.length ? { clerkOauthProviders } : {}),
				...(linkHosts.length ? { linkHosts } : {}),
				...(computeApiUrl ? { computeApiUrl: readApiBaseUrl(computeApiUrl, true) } : {}),
			},
		};
	} catch {
		return { ok: false, reason: "invalid" };
	}
}
