import { directProviderPassthroughProfile } from "./hosted-mitm-profiles";
import type { RuntimeManifest } from "./manifest-contract";
import type {
	RuntimeChannelAccount,
	RuntimeChannelsLoad,
	RuntimeManifestLoad,
} from "./manifest-source";
import type { MitmProfileInputBundle } from "./mitm-profiles";

type MitmProfile = MitmProfileInputBundle["profiles"][number];
type ChannelProvider = RuntimeChannelAccount["provider"];

interface ManagedChannelLink {
	account: RuntimeChannelAccount;
	accountKey: string;
	linkId: string;
	agentId: string;
	agentToken: string;
	secretRef: string;
}

export function applyRuntimeChannelsToManifestLoad(
	load: RuntimeManifestLoad,
	channels: RuntimeChannelsLoad | null,
): RuntimeManifestLoad {
	if (!channels) return load;
	const managedLinks = managedChannelLinks(channels.channels);
	const manifest = applyRuntimeChannelProjection(load.manifest, managedLinks);
	return {
		...load,
		manifest,
		secretValues: {
			...(load.secretValues ?? {}),
			...channelSecretValues(managedLinks),
		},
	};
}

function managedChannelLinks(channels: RuntimeChannelAccount[]): ManagedChannelLink[] {
	const links: ManagedChannelLink[] = [];
	for (const account of channels) {
		if (account.status !== "active") continue;
		for (const link of account.runtime_links) {
			if (link.status !== "active" || !link.agent_token) continue;
			const accountKey = channelAccountKey(account);
			links.push({
				account,
				accountKey,
				linkId: link.id,
				agentId: link.agent_id,
				agentToken: link.agent_token,
				secretRef: channelSecretRef(account.provider, accountKey),
			});
		}
	}
	return links.sort((left, right) =>
		`${left.account.provider}:${left.accountKey}`.localeCompare(
			`${right.account.provider}:${right.accountKey}`,
		),
	);
}

function applyRuntimeChannelProjection(
	manifest: RuntimeManifest,
	links: ManagedChannelLink[],
): RuntimeManifest {
	const managedProfiles = buildManagedChannelMitmProfiles(links, manifest.controlPlane.apiUrl);
	const directProviderPassthrough =
		managedProfiles.length > 0 ? directProviderPassthroughProfile(manifest.projection ?? {}) : null;
	return {
		...manifest,
		projection: {
			...(manifest.projection ?? {}),
			channels: buildOpenClawChannelsProjection(links, manifest.controlPlane.apiUrl),
		},
		mitmProfiles: mergeMitmProfiles(
			manifest.mitmProfiles,
			directProviderPassthrough ? [...managedProfiles, directProviderPassthrough] : managedProfiles,
		),
	};
}

function buildOpenClawChannelsProjection(
	links: ManagedChannelLink[],
	cloudApiUrl: string,
): Record<string, unknown> {
	const channels: Record<string, unknown> = {};
	for (const link of links) {
		const provider = link.account.provider;
		if (provider === "telegram") {
			const channel = ensureAccountChannel(channels, "telegram", link.accountKey);
			channel.accounts[link.accountKey] = {
				enabled: true,
				botToken: link.agentToken,
				dmPolicy: "open",
				groupPolicy: "open",
				allowFrom: ["*"],
				capabilities: { inlineButtons: "all" },
				groups: { "*": { requireMention: false } },
			};
			continue;
		}
		if (provider === "discord") {
			const channel = ensureAccountChannel(channels, "discord", link.accountKey);
			channel.accounts[link.accountKey] = {
				enabled: true,
				token: link.agentToken,
				dmPolicy: "open",
				groupPolicy: "open",
				allowFrom: ["*"],
				guilds: { "*": { requireMention: false, users: ["*"] } },
			};
			continue;
		}
		if (provider === "whatsapp") {
			const channel = ensureAccountChannel(channels, "whatsapp", link.accountKey);
			channel.accounts[link.accountKey] = {
				enabled: true,
				wsUrl: `${toWebSocketUrl(stripTrailingSlash(cloudApiUrl))}/api/channels/whatsapp/${link.account.id}/baileys`,
				token: link.agentToken,
			};
			continue;
		}
		if (provider === "imessage") {
			channels.bluebubbles = {
				enabled: true,
				serverUrl: `${stripTrailingSlash(cloudApiUrl)}/api/channels/imessage/bluebubbles`,
				password: link.agentToken,
			};
		}
	}
	return channels;
}

function ensureAccountChannel(
	channels: Record<string, unknown>,
	channelName: "telegram" | "discord" | "whatsapp",
	defaultAccount: string,
): { enabled: boolean; defaultAccount: string; accounts: Record<string, unknown> } {
	const existing = channels[channelName];
	if (isAccountChannel(existing)) return existing;
	const created = { enabled: true, defaultAccount, accounts: {} };
	channels[channelName] = created;
	return created;
}

function isAccountChannel(
	value: unknown,
): value is { enabled: boolean; defaultAccount: string; accounts: Record<string, unknown> } {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { accounts?: unknown }).accounts === "object" &&
		(value as { accounts?: unknown }).accounts !== null &&
		!Array.isArray((value as { accounts?: unknown }).accounts)
	);
}

function buildManagedChannelMitmProfiles(
	links: ManagedChannelLink[],
	cloudApiUrl: string,
): MitmProfile[] {
	const baseUrl = stripTrailingSlash(cloudApiUrl);
	const profiles: MitmProfile[] = [];
	for (const link of links) {
		const idSuffix = `${link.account.provider}-${link.accountKey}`;
		if (link.account.provider === "telegram") {
			profiles.push({
				id: `native-${idSuffix}-managed`,
				enabled: true,
				kind: "http",
				match: {
					scheme: "https",
					host: "api.telegram.org",
					pathPrefix: "/bot",
					path: {
						type: "secretRefPrefix",
						secretRef: link.secretRef,
						prefix: "/bot",
						suffix: "/",
					},
					headers: {},
					query: {},
				},
				rewrite: {
					upstreamBaseUrl: `${baseUrl}/api/channels/telegram`,
					preservePath: true,
					setHeaders: {},
				},
				logging: { redactHeaders: ["authorization"], redactUrlPatterns: ["/bot[^/]+"] },
				priority: 100,
				owner: "clawdi-native-channels",
			});
		}
		if (link.account.provider === "discord") {
			profiles.push({
				id: `native-${idSuffix}-rest-managed`,
				enabled: true,
				kind: "http",
				match: {
					scheme: "https",
					host: "discord.com",
					pathPrefix: "/api/",
					headers: {
						authorization: {
							type: "secretRefEquals",
							secretRef: link.secretRef,
							prefix: "Bot ",
						},
					},
					query: {},
				},
				rewrite: {
					upstreamBaseUrl: `${baseUrl}/api/channels/discord`,
					preservePath: true,
					setHeaders: {},
				},
				logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
				priority: 101,
				owner: "clawdi-native-channels",
			});
			profiles.push({
				id: `native-${idSuffix}-gateway-passthrough`,
				enabled: true,
				kind: "passthrough",
				match: {
					scheme: "wss",
					host: "gateway.discord.gg",
					pathPrefix: "/",
					headers: {},
					query: {},
				},
				logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
				priority: 201,
				owner: "clawdi-native-channels",
			});
		}
		if (link.account.provider === "whatsapp") {
			profiles.push({
				id: `native-${idSuffix}-graph-managed`,
				enabled: true,
				kind: "http",
				match: {
					scheme: "https",
					host: "graph.facebook.com",
					pathPrefix: "/v",
					headers: {
						authorization: {
							type: "secretRefEquals",
							secretRef: link.secretRef,
							prefix: "Bearer ",
						},
					},
					query: {},
				},
				rewrite: {
					upstreamBaseUrl: `${baseUrl}/api/channels/whatsapp/graph`,
					preservePath: true,
					setHeaders: {},
				},
				logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
				priority: 102,
				owner: "clawdi-native-channels",
			});
		}
	}
	return profiles;
}

function mergeMitmProfiles(
	existing: MitmProfileInputBundle | undefined,
	managed: MitmProfile[],
): MitmProfileInputBundle {
	const profiles = [...(existing?.profiles ?? [])];
	const managedIds = new Set(managed.map((profile) => profile.id));
	return {
		profiles: [
			...profiles.filter(
				(profile) => !managedIds.has(profile.id) && !isChannelProjectionProfile(profile),
			),
			...managed,
		],
	};
}

function isChannelProjectionProfile(profile: MitmProfile): boolean {
	return profile.owner === "clawdi-native-channels" || profile.id === "direct-provider-passthrough";
}

function channelSecretValues(links: ManagedChannelLink[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const link of links) {
		values[link.secretRef] = link.agentToken;
		values[link.secretRef.replace(/^secret:\/\//, "")] = link.agentToken;
	}
	return values;
}

function channelSecretRef(provider: ChannelProvider, accountKey: string): string {
	return `secret://channels/${provider}/${accountKey}/agent-token`;
}

function channelAccountKey(account: RuntimeChannelAccount): string {
	const compactId = account.id
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(0, 12)
		.toLowerCase();
	return `clawdi_${compactId || slug(account.name)}`;
}

function slug(value: string): string {
	const slugged = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 24);
	return slugged || "channel";
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function toWebSocketUrl(baseUrl: string): string {
	if (baseUrl.startsWith("https://")) return `wss://${baseUrl.slice("https://".length)}`;
	if (baseUrl.startsWith("http://")) return `ws://${baseUrl.slice("http://".length)}`;
	return baseUrl;
}
