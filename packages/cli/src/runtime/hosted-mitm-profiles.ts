import { type MitmProfileInputBundle, mitmProfileInputBundleSchema } from "./mitm-profiles";

type HostedMitmProfile = MitmProfileInputBundle["profiles"][number];

interface HostedRuntimeManifestProjection {
	mitmProfiles?: unknown;
	controlPlane?: {
		cloudApiUrl?: string | null;
		manifestUrl?: string | null;
	} | null;
	providers?: unknown;
}

interface HostedProviderProjection {
	baseUrl?: string | null;
	apiMode?: string | null;
}

export function hostedManifestMitmProfiles(
	hosted: HostedRuntimeManifestProjection,
): MitmProfileInputBundle {
	if (hosted.mitmProfiles !== undefined) {
		return mitmProfileInputBundleSchema.parse(hosted.mitmProfiles);
	}
	return { profiles: [] };
}

function providerUsesDirectProjection(apiMode: string | null): boolean {
	return apiMode === "openai_chat" || apiMode === "openai_responses";
}

export function directProviderPassthroughProfile(
	hosted: HostedRuntimeManifestProjection,
): HostedMitmProfile | null {
	return directProviderPassthroughProfiles(hosted)[0] ?? null;
}

export function directProviderPassthroughProfiles(
	hosted: HostedRuntimeManifestProjection,
): HostedMitmProfile[] {
	const profiles: HostedMitmProfile[] = [];
	const seenMatches = new Set<string>();
	for (const [providerId, provider] of providerProjectionEntries(hosted.providers)) {
		const profile = directProviderPassthroughProfileForProvider(providerId, provider);
		if (!profile) continue;
		const matchKey = `${profile.match.scheme}:${profile.match.host}:${profile.match.pathPrefix}`;
		if (seenMatches.has(matchKey)) continue;
		seenMatches.add(matchKey);
		profiles.push(profile);
	}
	return profiles;
}

function directProviderPassthroughProfileForProvider(
	providerId: string,
	provider: HostedProviderProjection,
): HostedMitmProfile | null {
	const providerBaseUrl = cleanBaseUrl(provider?.baseUrl);
	const providerApiMode = cleanString(provider?.apiMode);
	if (!providerBaseUrl || !providerUsesDirectProjection(providerApiMode)) return null;
	const parsed = new URL(providerBaseUrl);
	return {
		id:
			providerId === "default"
				? "direct-provider-passthrough"
				: `direct-provider-passthrough-${profileIdSuffix(providerId)}`,
		enabled: true,
		kind: "passthrough",
		match: {
			scheme: parsed.protocol.replace(/:$/, "") as "http" | "https" | "ws" | "wss",
			host: parsed.host.toLowerCase(),
			pathPrefix: providerPathPrefix(parsed.pathname),
			headers: {},
			query: {},
		},
		logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
		priority: 240,
		owner: "provider-projection",
	};
}

export function normalizeSecretRef(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return trimmed.startsWith("secret://") ? trimmed : `secret://${trimmed}`;
}

function providerProjectionEntries(value: unknown): Array<[string, HostedProviderProjection]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.entries(value)
		.filter((entry): entry is [string, HostedProviderProjection] => {
			const [providerId, provider] = entry;
			return (
				providerId.trim().length > 0 &&
				typeof provider === "object" &&
				provider !== null &&
				!Array.isArray(provider)
			);
		})
		.sort(([left], [right]) => {
			if (left === "default") return -1;
			if (right === "default") return 1;
			return left.localeCompare(right);
		});
}

function cleanString(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed || null;
}

function cleanBaseUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return null;
		return parsed.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

function providerPathPrefix(pathname: string): string {
	const cleaned = pathname.replace(/\/+$/, "");
	if (!cleaned) return "/";
	return `${cleaned}/`;
}

function profileIdSuffix(value: string): string {
	const suffix = value
		.toLowerCase()
		.replace(/[^a-z0-9-_.]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.replace(/[^a-z0-9]+$/, "");
	return suffix || "provider";
}
