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
	apiKeySecretRef?: string | null;
}

const MANAGED_MITM_PLACEHOLDER_VALUE = "clawdi-mitm-placeholder";

export function hostedManifestMitmProfiles(
	hosted: HostedRuntimeManifestProjection,
): MitmProfileInputBundle {
	if (hosted.mitmProfiles !== undefined) {
		return mitmProfileInputBundleSchema.parse(hosted.mitmProfiles);
	}
	return { profiles: managedProviderMitmProfiles(hosted) };
}

function providerUsesDirectProjection(apiMode: string | null): boolean {
	return apiMode === "openai_chat" || apiMode === "openai_responses";
}

export function directProviderPassthroughProfile(
	hosted: HostedRuntimeManifestProjection,
): HostedMitmProfile | null {
	const provider = defaultProviderProjection(hosted.providers);
	const providerBaseUrl = cleanBaseUrl(provider?.baseUrl);
	const providerApiMode = cleanString(provider?.apiMode);
	if (!providerBaseUrl || !providerUsesDirectProjection(providerApiMode)) return null;
	const parsed = new URL(providerBaseUrl);
	return {
		id: "direct-provider-passthrough",
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

function managedProviderMitmProfiles(hosted: HostedRuntimeManifestProjection): HostedMitmProfile[] {
	const provider = defaultProviderProjection(hosted.providers);
	const providerBaseUrl = cleanBaseUrl(provider?.baseUrl);
	const providerApiMode = cleanString(provider?.apiMode);
	const secretRef = normalizeSecretRef(provider?.apiKeySecretRef);
	if (!providerBaseUrl || !providerUsesCodexBackendProjection(providerApiMode) || !secretRef) {
		return [];
	}
	return [
		{
			id: "codex-chatgpt-backend-responses",
			enabled: true,
			kind: "provider",
			match: {
				scheme: "https",
				host: "chatgpt.com",
				path: { type: "equals", value: "/backend-api/codex/responses" },
				headers: {
					authorization: {
						type: "equals",
						value: MANAGED_MITM_PLACEHOLDER_VALUE,
						prefix: "Bearer ",
					},
				},
				query: {},
			},
			rewrite: {
				upstreamBaseUrl: codexBackendResponsesUrl(providerBaseUrl),
				preservePath: false,
				setHeaders: {
					authorization: {
						type: "secretRef",
						secretRef,
						prefix: "Bearer ",
					},
				},
			},
			logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
			priority: 125,
			owner: "provider-projection",
		},
	];
}

function providerUsesCodexBackendProjection(apiMode: string | null): boolean {
	return apiMode === "codex_responses" || apiMode === "openai_responses";
}

export function normalizeSecretRef(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return trimmed.startsWith("secret://") ? trimmed : `secret://${trimmed}`;
}

function defaultProviderProjection(value: unknown): HostedProviderProjection | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const provider = (value as { default?: unknown }).default;
	if (!provider || typeof provider !== "object" || Array.isArray(provider)) return null;
	return provider as HostedProviderProjection;
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

function codexBackendResponsesUrl(baseUrl: string): string {
	const parsed = new URL(baseUrl);
	const path = parsed.pathname.replace(/\/+$/, "");
	if (path.endsWith("/backend-api/codex/responses")) {
		parsed.pathname = path;
	} else if (path.endsWith("/backend-api/codex")) {
		parsed.pathname = `${path}/responses`;
	} else if (path.endsWith("/v1")) {
		parsed.pathname = `${path.slice(0, -"/v1".length)}/backend-api/codex/responses`;
	} else {
		parsed.pathname = `${path}/backend-api/codex/responses`;
	}
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/$/, "");
}
