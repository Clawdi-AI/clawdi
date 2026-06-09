import { type MitmProfileInputBundle, mitmProfileInputBundleSchema } from "./mitm-profiles";

type HostedMitmProfile = MitmProfileInputBundle["profiles"][number];
type HostedChannelName = "discord" | "telegram" | "imessage" | "whatsapp";

interface HostedRuntimeChannel {
	enabled: boolean;
	owner?: string | null;
	provider?: string | null;
	baseUrl?: string | null;
	apiBaseUrl?: string | null;
	restBaseUrl?: string | null;
	gatewayBaseUrl?: string | null;
	websocketBaseUrl?: string | null;
	upstreamBaseUrl?: string | null;
	secretRef?: string | null;
	tokenSecretRef?: string | null;
	botTokenSecretRef?: string | null;
	passwordSecretRef?: string | null;
	apiKeySecretRef?: string | null;
}

interface HostedRuntimeManifestProjection {
	mitmProfiles?: unknown;
	providers?: {
		default?: {
			baseUrl?: string | null;
			apiKeySecretRef?: string | null;
		} | null;
	} | null;
	channels?: Partial<Record<HostedChannelName, HostedRuntimeChannel>> | null;
}

type ChannelProfileBuilder = {
	channel: HostedChannelName;
	build: (
		baseUrl: string | null,
		channel: HostedRuntimeChannel | undefined,
		owner: string,
	) => HostedMitmProfile[];
};

const CHANNEL_PROFILE_BUILDERS: readonly ChannelProfileBuilder[] = [
	{
		channel: "discord",
		build: (baseUrl, channel, owner) => {
			if (!baseUrl) return [];
			const botTokenRef = channelTokenSecretRef(channel);
			return [
				channelProfile({
					id: "discord-rest-channel",
					kind: "http",
					scheme: "https",
					host: "discord.com",
					pathPrefix: "/api/",
					headers: botTokenRef
						? {
								authorization: {
									type: "secretRefEquals",
									secretRef: botTokenRef,
									prefix: "Bot ",
								},
							}
						: undefined,
					upstreamBaseUrl: baseUrl,
					redactHeaders: ["authorization"],
					priority: 100,
					owner,
				}),
				channelProfile({
					id: "discord-gateway-channel",
					kind: "websocket",
					scheme: "wss",
					host: "gateway.discord.gg",
					pathPrefix: "/",
					upstreamBaseUrl: channelWebSocketBaseUrl(channel) ?? baseUrl,
					priority: 130,
					owner,
				}),
			];
		},
	},
	{
		channel: "telegram",
		build: (baseUrl, channel, owner) => {
			if (!baseUrl) return [];
			const botTokenRef = channelTokenSecretRef(channel);
			return [
				channelProfile({
					id: "telegram-bot-api-channel",
					kind: "http",
					scheme: "https",
					host: "api.telegram.org",
					pathPrefix: "/bot",
					path: botTokenRef
						? {
								type: "secretRefPrefix",
								secretRef: botTokenRef,
								prefix: "/bot",
								suffix: "/",
							}
						: undefined,
					upstreamBaseUrl: baseUrl,
					redactUrlPatterns: ["/bot[^/]+/"],
					priority: 110,
					owner,
				}),
			];
		},
	},
	{
		channel: "imessage",
		build: (baseUrl, channel, owner) => {
			if (!baseUrl) return [];
			const passwordRef = normalizeSecretRef(
				channel?.passwordSecretRef ?? channel?.tokenSecretRef ?? channel?.secretRef,
			);
			return [
				channelProfile({
					id: "bluebubbles-imessage-channel",
					kind: "http",
					scheme: "https",
					host: "bluebubbles.invalid",
					pathPrefix: "/api/",
					query: passwordRef
						? {
								password: {
									type: "secretRefEquals",
									secretRef: passwordRef,
								},
							}
						: undefined,
					upstreamBaseUrl: baseUrl,
					redactUrlPatterns: ["password=[^&]+"],
					priority: 120,
					owner,
				}),
			];
		},
	},
	{
		channel: "whatsapp",
		build: (baseUrl, channel, owner) =>
			baseUrl
				? [
						channelProfile({
							id: "whatsapp-web-channel",
							kind: "websocket",
							scheme: "wss",
							host: "web.whatsapp.com",
							pathPrefix: "/ws/",
							upstreamBaseUrl: channelWebSocketBaseUrl(channel) ?? baseUrl,
							preservePath: false,
							priority: 140,
							owner,
						}),
					]
				: [],
	},
];

export function hostedManifestMitmProfiles(
	hosted: HostedRuntimeManifestProjection,
): MitmProfileInputBundle {
	if (hosted.mitmProfiles !== undefined) {
		return mitmProfileInputBundleSchema.parse(hosted.mitmProfiles);
	}

	const profiles: HostedMitmProfile[] = [];
	const channels = hosted.channels ?? {};
	for (const entry of CHANNEL_PROFILE_BUILDERS) {
		const channel = channels[entry.channel];
		if (channel?.enabled !== true) continue;
		profiles.push(
			...entry.build(channelProfileBaseUrl(entry.channel, channel), channel, channelOwner(channel)),
		);
	}

	const provider = hosted.providers?.default;
	const providerBaseUrl = cleanBaseUrl(provider?.baseUrl);
	const providerApiKeySecretRef = normalizeSecretRef(provider?.apiKeySecretRef);
	if (providerBaseUrl && providerApiKeySecretRef) {
		profiles.push(...providerMitmProfiles(providerBaseUrl, providerApiKeySecretRef));
	}

	return { profiles };
}

function channelProfile(input: {
	id: string;
	kind: "http" | "websocket";
	scheme: "https" | "wss";
	host: string;
	pathPrefix: string;
	path?: HostedMitmProfile["match"]["path"];
	headers?: HostedMitmProfile["match"]["headers"];
	query?: HostedMitmProfile["match"]["query"];
	upstreamBaseUrl: string;
	preservePath?: boolean;
	redactHeaders?: string[];
	redactUrlPatterns?: string[];
	priority: number;
	owner: string;
}): HostedMitmProfile {
	return {
		id: input.id,
		enabled: true,
		kind: input.kind,
		match: {
			scheme: input.scheme,
			host: input.host,
			pathPrefix: input.pathPrefix,
			...(input.path ? { path: input.path } : {}),
			headers: input.headers ?? {},
			query: input.query ?? {},
		},
		rewrite: {
			upstreamBaseUrl: input.upstreamBaseUrl,
			preservePath: input.preservePath ?? true,
			setHeaders: {},
		},
		logging: {
			redactHeaders: input.redactHeaders ?? [],
			redactUrlPatterns: input.redactUrlPatterns ?? [],
		},
		priority: input.priority,
		owner: input.owner,
	};
}

function channelBaseUrl(channel: HostedRuntimeChannel | undefined): string | null {
	return cleanBaseUrl(channel?.apiBaseUrl ?? channel?.baseUrl ?? channel?.upstreamBaseUrl);
}

function channelProfileBaseUrl(
	channelName: HostedChannelName,
	channel: HostedRuntimeChannel | undefined,
): string | null {
	if (channelName === "whatsapp")
		return channelWebSocketBaseUrl(channel) ?? channelBaseUrl(channel);
	return channelBaseUrl(channel);
}

function channelWebSocketBaseUrl(channel: HostedRuntimeChannel | undefined): string | null {
	return cleanBaseUrl(
		channel?.gatewayBaseUrl ??
			channel?.websocketBaseUrl ??
			channel?.upstreamBaseUrl ??
			channel?.baseUrl,
	);
}

function channelOwner(channel: HostedRuntimeChannel | undefined): string {
	return channel?.owner?.trim() || channel?.provider?.trim() || "channel";
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
				upstreamBaseUrl: providerBaseUrl,
				preservePath: true,
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
				upstreamBaseUrl: appendCleanPath(providerBaseUrl, "/responses"),
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

function channelTokenSecretRef(channel: HostedRuntimeChannel | undefined): string | null {
	return normalizeSecretRef(
		channel?.botTokenSecretRef ?? channel?.tokenSecretRef ?? channel?.secretRef,
	);
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
