import { readApiBaseUrl } from "@clawdi/shared/api";
import { readLinkHosts } from "../../../config/linking.cjs";

export type MobileRuntimeConfig = Readonly<{
	cloudApiUrl: string;
	clerkPublishableKey: string;
	computeApiUrl?: string;
	revenueCatAppleKey?: string;
	revenueCatGoogleKey?: string;
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
	{
		requireClerk = true,
		isDevelopment = false,
		environment,
	}: {
		requireClerk?: boolean;
		isDevelopment?: boolean;
		environment?: string;
	} = {},
): MobileRuntimeConfigResult {
	const cloudApiUrl = requiredString(values.cloudApiUrl);
	const clerkPublishableKey = requiredString(values.clerkPublishableKey);
	const computeApiUrl = requiredString(values.computeApiUrl);
	const revenueCatAppleKey = requiredString(values.revenueCatAppleKey);
	const revenueCatGoogleKey = requiredString(values.revenueCatGoogleKey);
	if (
		!isDevelopment &&
		(!requireClerk || (environment !== "preview" && environment !== "production"))
	)
		return { ok: false, reason: "invalid" };
	if (
		!cloudApiUrl ||
		(requireClerk && !clerkPublishableKey) ||
		(!isDevelopment && !computeApiUrl)
	) {
		return { ok: false, reason: "missing" };
	}
	if (clerkPublishableKey && !clerkPublishableKeyPattern.test(clerkPublishableKey))
		return { ok: false, reason: "invalid" };
	if (
		!isDevelopment &&
		environment === "production" &&
		!clerkPublishableKey?.startsWith("pk_live_")
	)
		return { ok: false, reason: "invalid" };
	if (values.computeApiUrl != null && typeof values.computeApiUrl !== "string")
		return { ok: false, reason: "invalid" };
	try {
		if (
			!isDevelopment &&
			(new URL(cloudApiUrl).protocol !== "https:" ||
				(computeApiUrl && new URL(computeApiUrl).protocol !== "https:"))
		)
			return { ok: false, reason: "invalid" };
		const linkHosts = readLinkHosts(values.linkHosts);
		return {
			ok: true,
			value: {
				cloudApiUrl: readApiBaseUrl(cloudApiUrl),
				clerkPublishableKey: clerkPublishableKey ?? "",
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
