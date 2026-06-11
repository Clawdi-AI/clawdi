import { type MitmProfileInputBundle, mitmProfileInputBundleSchema } from "./mitm-profiles";

type HostedMitmProfile = MitmProfileInputBundle["profiles"][number];

interface HostedRuntimeManifestProjection {
	mitmProfiles?: unknown;
	controlPlane?: {
		cloudApiUrl?: string | null;
		manifestUrl?: string | null;
	} | null;
	providers?: {
		default?: {
			baseUrl?: string | null;
			apiKeySecretRef?: string | null;
		} | null;
	} | null;
}

export function hostedManifestMitmProfiles(
	hosted: HostedRuntimeManifestProjection,
): MitmProfileInputBundle {
	if (hosted.mitmProfiles !== undefined) {
		return mitmProfileInputBundleSchema.parse(hosted.mitmProfiles);
	}

	const profiles: HostedMitmProfile[] = nativeChannelMitmProfiles(hosted);
	const provider = hosted.providers?.default;
	const providerBaseUrl = cleanBaseUrl(provider?.baseUrl);
	const providerApiKeySecretRef = normalizeSecretRef(provider?.apiKeySecretRef);
	if (providerBaseUrl && providerApiKeySecretRef) {
		profiles.push(...providerMitmProfiles(providerBaseUrl, providerApiKeySecretRef));
	}

	return { profiles };
}

function nativeChannelMitmProfiles(hosted: HostedRuntimeManifestProjection): HostedMitmProfile[] {
	const cloudApiUrl = hostedCloudApiUrl(hosted);
	if (!cloudApiUrl) return [];
	const cloudWsUrl = toWebSocketUrl(cloudApiUrl);
	return [
		{
			id: "native-telegram-bot-api",
			enabled: true,
			kind: "http",
			match: {
				scheme: "https",
				host: "api.telegram.org",
				pathPrefix: "/bot",
				headers: {},
				query: {},
			},
			rewrite: {
				upstreamBaseUrl: appendCleanPath(cloudApiUrl, "/api/channels/telegram"),
				preservePath: true,
				setHeaders: {},
			},
			logging: { redactHeaders: ["authorization"], redactUrlPatterns: ["/bot[^/]+"] },
			priority: 100,
			owner: "clawdi-native-channels",
		},
		{
			id: "native-discord-rest",
			enabled: true,
			kind: "http",
			match: {
				scheme: "https",
				host: "discord.com",
				pathPrefix: "/api/",
				headers: {},
				query: {},
			},
			rewrite: {
				upstreamBaseUrl: appendCleanPath(cloudApiUrl, "/api/channels/discord"),
				preservePath: true,
				setHeaders: {},
			},
			logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
			priority: 101,
			owner: "clawdi-native-channels",
		},
		{
			id: "native-discord-gateway",
			enabled: true,
			kind: "websocket",
			match: {
				scheme: "wss",
				host: "gateway.discord.gg",
				pathPrefix: "/",
				headers: {},
				query: {},
			},
			rewrite: {
				upstreamBaseUrl: appendCleanPath(cloudWsUrl, "/api/channels/discord/gateway"),
				preservePath: true,
				setHeaders: {},
			},
			logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
			priority: 102,
			owner: "clawdi-native-channels",
		},
		{
			id: "native-whatsapp-graph",
			enabled: true,
			kind: "http",
			match: {
				scheme: "https",
				host: "graph.facebook.com",
				pathPrefix: "/v",
				headers: {},
				query: {},
			},
			rewrite: {
				upstreamBaseUrl: appendCleanPath(cloudApiUrl, "/api/channels/whatsapp/graph"),
				preservePath: true,
				setHeaders: {},
			},
			logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
			priority: 103,
			owner: "clawdi-native-channels",
		},
	];
}

function providerMitmProfiles(
	providerBaseUrl: string,
	apiKeySecretRef: string,
): HostedMitmProfile[] {
	const apiKeyHeader: HostedMitmProfile["match"]["headers"] = {
		authorization: {
			type: "secretRefEquals" as const,
			secretRef: apiKeySecretRef,
			prefix: "Bearer ",
		},
	};
	return [
		{
			id: "codex-openai-responses",
			enabled: true,
			kind: "provider",
			match: {
				scheme: "https",
				host: "api.openai.com",
				pathPrefix: "/v1/",
				headers: apiKeyHeader,
				query: {},
			},
			rewrite: {
				upstreamBaseUrl: openAiResponsesUrl(providerBaseUrl),
				preservePath: false,
				setHeaders: {},
			},
			logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
			priority: 150,
			owner: "provider-projection",
		},
		{
			id: "codex-chatgpt-backend-responses",
			enabled: true,
			kind: "provider",
			match: {
				scheme: "https",
				host: "chatgpt.com",
				path: { type: "equals", value: "/backend-api/codex/responses" },
				headers: {
					authorization: { type: "exists" },
				},
				query: {},
			},
			rewrite: {
				upstreamBaseUrl: chatGptCodexBackendResponsesUrl(providerBaseUrl),
				preservePath: false,
				setHeaders: {
					authorization: {
						type: "secretRef",
						secretRef: apiKeySecretRef,
						prefix: "Bearer ",
					},
				},
			},
			logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
			priority: 151,
			owner: "provider-projection",
		},
	];
}

function openAiResponsesUrl(providerBaseUrl: string): string {
	return appendCleanPath(providerBaseUrl, "/responses");
}

function chatGptCodexBackendResponsesUrl(providerBaseUrl: string): string {
	return openAiResponsesUrl(providerBaseUrl);
}

function hostedCloudApiUrl(hosted: HostedRuntimeManifestProjection): string | null {
	const explicit = cleanBaseUrl(hosted.controlPlane?.cloudApiUrl);
	if (explicit) return explicit;
	const manifestUrl = cleanBaseUrl(hosted.controlPlane?.manifestUrl);
	if (!manifestUrl) return null;
	try {
		return new URL(manifestUrl).origin;
	} catch {
		return null;
	}
}

function toWebSocketUrl(baseUrl: string): string {
	const parsed = new URL(baseUrl);
	if (parsed.protocol === "https:") parsed.protocol = "wss:";
	else if (parsed.protocol === "http:") parsed.protocol = "ws:";
	return parsed.toString().replace(/\/+$/, "");
}

export function normalizeSecretRef(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	return trimmed.startsWith("secret://") ? trimmed : `secret://${trimmed}`;
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

function appendCleanPath(baseUrl: string, path: string): string {
	const parsed = new URL(baseUrl);
	const basePath = parsed.pathname.replace(/\/+$/, "");
	const childPath = path.replace(/^\/+/, "");
	parsed.pathname = `${basePath}/${childPath}`;
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "");
}
