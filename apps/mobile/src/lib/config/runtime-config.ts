import { readApiBaseUrl } from "@clawdi/shared/api";
import { readLinkHosts } from "@clawdi/shared/linking";

export type MobileRuntimeConfig = Readonly<{
	cloudApiUrl: string;
	clerkPublishableKey: string;
	environment?: string;
	computeApiUrl?: string;
	revenueCatAppleKey?: string;
	revenueCatGoogleKey?: string;
	revenueCatCustomerCenterEnabled?: boolean;
	linkHosts?: readonly string[];
	/** Web's Chatwoot website inbox; live chat needs both values, like Web. */
	chatwoot?: Readonly<{ baseUrl: string; websiteToken: string }>;
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
	revenueCatCustomerCenterEnabled?: unknown;
	linkHosts?: unknown;
	chatwootBaseUrl?: unknown;
	chatwootWebsiteToken?: unknown;
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
	const revenueCatCustomerCenterEnabled = values.revenueCatCustomerCenterEnabled === true;
	const chatwootBaseUrl = requiredString(values.chatwootBaseUrl)?.replace(/\/+$/, "");
	const chatwootWebsiteToken = requiredString(values.chatwootWebsiteToken);
	// RevenueCat Test Store public SDK keys start with `test_`; never ship them to stores.
	if (
		environment === "production" &&
		[revenueCatAppleKey, revenueCatGoogleKey].some((key) => key?.startsWith("test_"))
	)
		return { ok: false, reason: "invalid" };
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
			[cloudApiUrl, computeApiUrl, chatwootBaseUrl].some(
				(url) => url && new URL(url).protocol !== "https:",
			)
		)
			return { ok: false, reason: "invalid" };
		const linkHosts = readLinkHosts(values.linkHosts);
		return {
			ok: true,
			value: {
				cloudApiUrl: readApiBaseUrl(cloudApiUrl),
				clerkPublishableKey: clerkPublishableKey ?? "",
				...(environment ? { environment } : {}),
				...(linkHosts.length ? { linkHosts } : {}),
				...(computeApiUrl ? { computeApiUrl: readApiBaseUrl(computeApiUrl, true) } : {}),
				...(revenueCatAppleKey ? { revenueCatAppleKey } : {}),
				...(revenueCatGoogleKey ? { revenueCatGoogleKey } : {}),
				...(revenueCatCustomerCenterEnabled ? { revenueCatCustomerCenterEnabled: true } : {}),
				...(chatwootBaseUrl && chatwootWebsiteToken
					? { chatwoot: { baseUrl: chatwootBaseUrl, websiteToken: chatwootWebsiteToken } }
					: {}),
			},
		};
	} catch {
		return { ok: false, reason: "invalid" };
	}
}
