import { createHash } from "node:crypto";
import type { EgressProfileInputBundle } from "./egress-profiles";
import {
	buildManagedWhatsAppAdapterProjection,
	type ManagedWhatsAppAdapterProjection,
} from "./managed-whatsapp-adapters";
import type { RuntimeManifest } from "./manifest-contract";
import type {
	RuntimeBundleChannelBinding,
	RuntimeChannelAccount,
	RuntimeChannelsLoad,
	RuntimeManifestLoad,
} from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { runtimeSecretValue } from "./secret-values";
import { WHATSAPP_UPSTREAM_READY } from "./whatsapp-gate";

type EgressProfile = EgressProfileInputBundle["profiles"][number];
type ChannelProvider = RuntimeChannelAccount["provider"];

const HERMES_MANAGED_CHANNEL_ENV = [
	"TELEGRAM_ALLOW_ALL_USERS",
	"DISCORD_ALLOW_ALL_USERS",
	"HERMES_TELEGRAM_DISABLE_FALLBACK_IPS",
	"CLAWDI_WHATSAPP_RELAY_URL",
	"CLAWDI_WHATSAPP_ACCOUNT_ID",
] as const;
const HERMES_MANAGED_CHANNEL_SECRET_ENV = [
	"TELEGRAM_BOT_TOKEN",
	"DISCORD_BOT_TOKEN",
	"CLAWDI_WHATSAPP_LINK_TOKEN",
] as const;
const OPENCLAW_CHANNEL_TOKEN_ENV_PREFIX = "CLAWDI_CHANNEL_";
const OPENCLAW_CHANNEL_TOKEN_ENV_SUFFIX = "_AGENT_TOKEN";
const OPENCLAW_MANAGED_WHATSAPP_ENV = [
	"CLAWDI_WHATSAPP_RELAY_URL",
	"CLAWDI_WHATSAPP_ACCOUNT_ID",
] as const;
const OPENCLAW_MANAGED_WHATSAPP_SECRET_ENV = "CLAWDI_WHATSAPP_LINK_TOKEN";

interface ManagedChannelLink {
	account: RuntimeChannelAccount;
	accountKey: string;
	linkId: string;
	agentId: string;
	agentToken: string;
	secretRef: string;
	placeholderSecretRef: string;
}

interface OpenClawEnvSecretRef {
	source: "env";
	provider: "default";
	id: string;
}

export function applyRuntimeChannelsToManifestLoad(
	load: RuntimeManifestLoad,
	channels: RuntimeChannelsLoad | null,
	paths: RuntimePaths = getRuntimePaths({ mode: "hosted" }),
): RuntimeManifestLoad {
	if (!channels) return load;
	const managedLinks = managedChannelLinks(channels.channels);
	const manifest = applyRuntimeChannelProjection(load.manifest, managedLinks, paths);
	const secretValues = {
		...(load.secretValues ?? {}),
		...channelSecretValues(managedLinks),
	};
	return {
		...load,
		manifest,
		sourceManifest: load.sourceManifest ?? load.manifest,
		secretValues: Object.keys(secretValues).length > 0 ? secretValues : undefined,
	};
}

export function applyRuntimeBundleChannelsToManifestLoad(
	load: RuntimeManifestLoad,
	paths: RuntimePaths = getRuntimePaths({ mode: "hosted" }),
): RuntimeManifestLoad {
	if (!load.channelBindings) return load;
	const secretValues = load.secretValues ?? {};
	const links = load.channelBindings.map((binding) =>
		managedBundleChannelLink(binding, secretValues),
	);
	return {
		...load,
		manifest: applyRuntimeChannelProjection(load.manifest, links, paths),
		sourceManifest: load.sourceManifest ?? load.manifest,
	};
}

function managedBundleChannelLink(
	binding: RuntimeBundleChannelBinding,
	secretValues: Record<string, string>,
): ManagedChannelLink {
	const agentToken = runtimeSecretValue(secretValues, binding.agentTokenSecretRef);
	const placeholderToken = runtimeSecretValue(secretValues, binding.placeholderTokenSecretRef);
	if (!agentToken) throw new Error(`runtime bundle is missing ${binding.agentTokenSecretRef}`);
	if (!placeholderToken) {
		throw new Error(`runtime bundle is missing ${binding.placeholderTokenSecretRef}`);
	}
	return {
		account: {
			id: binding.accountKey,
			provider: binding.provider,
			name: binding.accountKey,
			status: "active",
			visibility: "private",
			runtime_links: [],
			runtime_credentials: [],
		},
		accountKey: binding.accountKey,
		linkId: binding.accountKey,
		agentId: "bundle",
		agentToken,
		secretRef: binding.agentTokenSecretRef,
		placeholderSecretRef: binding.placeholderTokenSecretRef,
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
				secretRef: channelLinkSecretRef(account.provider, accountKey, link.id),
				placeholderSecretRef: channelPlaceholderSecretRef(account.provider, accountKey),
			});
		}
	}
	const sorted = links.sort((left, right) =>
		`${left.account.provider}:${left.accountKey}:${left.linkId}`.localeCompare(
			`${right.account.provider}:${right.accountKey}:${right.linkId}`,
		),
	);
	const projected = sorted.filter(
		(link) => link.account.provider !== "whatsapp" || WHATSAPP_UPSTREAM_READY,
	);
	assertSingleManagedLinkPerProvider(projected);
	return projected;
}

function applyRuntimeChannelProjection(
	manifest: RuntimeManifest,
	links: ManagedChannelLink[],
	paths: RuntimePaths,
): RuntimeManifest {
	void paths;
	assertSingleManagedLinkPerProvider(links);
	const whatsappLink = singleLinkForProvider(links, "whatsapp");
	const whatsappProjection = whatsappLink
		? buildManagedWhatsAppAdapterProjection({
				accountId: whatsappLink.account.id,
				accountKey: whatsappLink.accountKey,
				relayUrl: manifest.controlPlane.apiUrl,
				linkTokenSecretRef: whatsappLink.secretRef,
			})
		: null;
	const managedProfiles = buildManagedChannelEgressProfiles(links, manifest.controlPlane.apiUrl);
	const projected: RuntimeManifest = {
		...manifest,
		projection: {
			...(manifest.projection ?? {}),
			channels: buildOpenClawChannelsProjection(links, whatsappProjection),
			// Runtime credentials may still appear in an older control-plane response.
			// Managed WhatsApp never consumes or projects provider/socket material.
			channelCredentials: [],
		},
		egressProfiles: mergeEgressProfiles(manifest.egressProfiles, managedProfiles),
	};
	return applyHermesRuntimeChannelSettings(
		applyOpenClawRuntimeChannelSettings(projected, links, whatsappProjection),
		links,
		whatsappProjection,
	);
}

function buildOpenClawChannelsProjection(
	links: ManagedChannelLink[],
	whatsappProjection: ManagedWhatsAppAdapterProjection | null,
): Record<string, unknown> {
	const channels: Record<string, unknown> = {};
	for (const link of links) {
		const provider = link.account.provider;
		if (provider === "whatsapp" && !WHATSAPP_UPSTREAM_READY) continue;
		if (provider === "telegram") {
			const channel = ensureAccountChannel(channels, "telegram", link.accountKey);
			channel.accounts[link.accountKey] = {
				enabled: true,
				botToken: openClawChannelPlaceholderTokenSecretRef(link),
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
				token: openClawChannelPlaceholderTokenSecretRef(link),
				dmPolicy: "open",
				groupPolicy: "open",
				allowFrom: ["*"],
				guilds: { "*": { requireMention: false, users: ["*"] } },
			};
			continue;
		}
		if (provider === "whatsapp" && whatsappProjection) {
			channels.whatsapp = whatsappProjection.openclaw.channel;
		}
	}
	return channels;
}

function applyOpenClawRuntimeChannelSettings(
	manifest: RuntimeManifest,
	links: ManagedChannelLink[],
	whatsappProjection: ManagedWhatsAppAdapterProjection | null,
): RuntimeManifest {
	const openclaw = manifest.runtimes.openclaw;
	if (!openclaw?.enabled) return manifest;

	const existingRun = openclaw.run ?? { env: {}, prependPath: [] };
	const env = omitKeys(existingRun.env ?? {}, OPENCLAW_MANAGED_WHATSAPP_ENV);
	const secretEnv = omitOpenClawManagedChannelSecretEnv(existingRun.secretEnv ?? {});
	for (const link of links) {
		if (link.account.provider === "whatsapp") continue;
		secretEnv[openClawChannelTokenEnvName(link)] = link.placeholderSecretRef;
	}
	delete secretEnv[OPENCLAW_MANAGED_WHATSAPP_SECRET_ENV];
	if (whatsappProjection) {
		Object.assign(env, whatsappProjection.openclaw.env);
		Object.assign(secretEnv, whatsappProjection.openclaw.secretEnv);
	}
	if (!openclaw.run && Object.keys(env).length === 0 && Object.keys(secretEnv).length === 0) {
		return manifest;
	}

	return {
		...manifest,
		runtimes: {
			...manifest.runtimes,
			openclaw: {
				...openclaw,
				run: { ...existingRun, env, secretEnv },
			},
		},
	};
}

function applyHermesRuntimeChannelSettings(
	manifest: RuntimeManifest,
	links: ManagedChannelLink[],
	whatsappProjection: ManagedWhatsAppAdapterProjection | null,
): RuntimeManifest {
	const hermes = manifest.runtimes.hermes;
	if (!hermes?.enabled) return manifest;

	const telegram = singleLinkForProvider(links, "telegram");
	const discord = singleLinkForProvider(links, "discord");
	const existingRun = hermes.run ?? { env: {}, prependPath: [] };
	const env = omitKeys(existingRun.env ?? {}, HERMES_MANAGED_CHANNEL_ENV);
	const secretEnv = omitKeys(existingRun.secretEnv ?? {}, HERMES_MANAGED_CHANNEL_SECRET_ENV);

	if (telegram) {
		env.TELEGRAM_ALLOW_ALL_USERS = "true";
		env.HERMES_TELEGRAM_DISABLE_FALLBACK_IPS = "true";
		secretEnv.TELEGRAM_BOT_TOKEN = telegram.placeholderSecretRef;
	}
	if (discord) {
		env.DISCORD_ALLOW_ALL_USERS = "true";
		secretEnv.DISCORD_BOT_TOKEN = discord.placeholderSecretRef;
	}
	if (whatsappProjection) {
		Object.assign(env, whatsappProjection.hermes.env);
		Object.assign(secretEnv, whatsappProjection.hermes.secretEnv);
	}

	return {
		...manifest,
		runtimes: {
			...manifest.runtimes,
			hermes: {
				...hermes,
				run: { ...existingRun, env, secretEnv },
			},
		},
	};
}

function singleLinkForProvider(
	links: ManagedChannelLink[],
	provider: ChannelProvider,
): ManagedChannelLink | null {
	const matching = links.filter((link) => link.account.provider === provider);
	if (matching.length > 1) throw new Error(runtimeProviderLinkLimitDetail(provider));
	return matching[0] ?? null;
}

function assertSingleManagedLinkPerProvider(links: ManagedChannelLink[]): void {
	for (const provider of ["telegram", "discord", "whatsapp"] as const) {
		singleLinkForProvider(links, provider);
	}
}

function runtimeProviderLinkLimitDetail(provider: ChannelProvider): string {
	const label =
		provider === "telegram" ? "Telegram" : provider === "discord" ? "Discord" : "WhatsApp";
	return `This Agent has multiple active ${label} bots. Unlink the extras until only one remains.`;
}

function openClawChannelPlaceholderTokenSecretRef(link: ManagedChannelLink): OpenClawEnvSecretRef {
	return { source: "env", provider: "default", id: openClawChannelTokenEnvName(link) };
}

function openClawChannelTokenEnvName(link: ManagedChannelLink): string {
	return `${OPENCLAW_CHANNEL_TOKEN_ENV_PREFIX}${envKeySegment(link.account.provider)}_${envKeySegment(
		link.accountKey,
	)}${OPENCLAW_CHANNEL_TOKEN_ENV_SUFFIX}`;
}

function envKeySegment(value: string): string {
	const segment = value
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return segment || "CHANNEL";
}

function omitOpenClawManagedChannelSecretEnv(
	input: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(input).filter(([key]) => !isOpenClawManagedChannelSecretEnv(key)),
	);
}

function isOpenClawManagedChannelSecretEnv(key: string): boolean {
	return (
		key.startsWith(OPENCLAW_CHANNEL_TOKEN_ENV_PREFIX) &&
		key.endsWith(OPENCLAW_CHANNEL_TOKEN_ENV_SUFFIX)
	);
}

function omitKeys<T extends string>(
	input: Record<string, string>,
	keys: readonly T[],
): Record<string, string> {
	const omitted = new Set<string>(keys);
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		if (!omitted.has(key)) output[key] = value;
	}
	return output;
}

function ensureAccountChannel(
	channels: Record<string, unknown>,
	channelName: "telegram" | "discord",
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

function buildManagedChannelEgressProfiles(
	links: ManagedChannelLink[],
	cloudApiUrl: string,
): EgressProfile[] {
	const baseUrl = stripTrailingSlash(cloudApiUrl);
	const profiles: EgressProfile[] = [];
	for (const link of links) {
		const idSuffix = `${link.account.provider}-${link.accountKey}`;
		if (link.account.provider === "telegram") {
			for (const route of [
				{ id: `native-${idSuffix}-managed`, pathPrefix: "/bot" },
				{ id: `native-${idSuffix}-file-managed`, pathPrefix: "/file/bot" },
			] as const) {
				profiles.push({
					id: route.id,
					enabled: true,
					kind: "http",
					match: {
						scheme: "https",
						host: "api.telegram.org",
						pathPrefix: route.pathPrefix,
						path: {
							type: "secretRefPrefix",
							secretRef: link.placeholderSecretRef,
							prefix: route.pathPrefix,
							suffix: "/",
						},
						headers: {},
						query: {},
					},
					rewrite: {
						upstreamBaseUrl: `${baseUrl}/v1/channels/telegram`,
						preservePath: true,
						setHeaders: {
							authorization: {
								type: "secretRef",
								secretRef: link.secretRef,
								prefix: "Bearer ",
							},
						},
					},
					logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
					priority: 100,
					owner: "clawdi-native-channels",
				});
			}
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
							secretRef: link.placeholderSecretRef,
							prefix: "Bot ",
						},
					},
					query: {},
				},
				rewrite: {
					upstreamBaseUrl: `${baseUrl}/v1/channels/discord`,
					preservePath: true,
					setHeaders: {
						authorization: {
							type: "secretRef",
							secretRef: link.secretRef,
							prefix: "Bot ",
						},
					},
				},
				logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
				priority: 101,
				owner: "clawdi-native-channels",
			});
			profiles.push({
				id: `native-${idSuffix}-gateway-managed`,
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
					upstreamBaseUrl: `${toWebSocketUrl(baseUrl)}/v1/channels/discord/gateway`,
					preservePath: false,
					setHeaders: {
						authorization: {
							type: "secretRef",
							secretRef: link.secretRef,
							prefix: "Bearer ",
						},
					},
				},
				logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
				priority: 201,
				owner: "clawdi-native-channels",
			});
		}
	}
	return profiles;
}

function mergeEgressProfiles(
	existing: EgressProfileInputBundle | undefined,
	managed: EgressProfile[],
): EgressProfileInputBundle {
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

function isChannelProjectionProfile(profile: EgressProfile): boolean {
	return (
		profile.owner === "clawdi-native-channels" ||
		profile.id === "direct-provider-passthrough" ||
		profile.id.startsWith("direct-provider-passthrough-")
	);
}

function channelSecretValues(links: ManagedChannelLink[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (const link of links) {
		if (link.account.provider === "whatsapp" && !WHATSAPP_UPSTREAM_READY) continue;
		values[link.secretRef] = link.agentToken;
		if (link.account.provider === "whatsapp") continue;
		values[link.placeholderSecretRef] = channelPlaceholderToken(
			link.account.provider,
			link.accountKey,
		);
	}
	return values;
}

function channelLinkSecretRef(
	provider: ChannelProvider,
	accountKey: string,
	linkId: string,
): string {
	return `secret://channels/${provider}/${accountKey}/links/${linkId}/agent-token`;
}

function channelPlaceholderSecretRef(provider: ChannelProvider, accountKey: string): string {
	return `secret://channels/${provider}/${accountKey}/placeholder-token`;
}

function channelPlaceholderToken(provider: ChannelProvider, accountKey: string): string {
	const suffix = createHash("sha256")
		.update(`${provider}:${accountKey}`)
		.digest("hex")
		.slice(0, 32);
	if (provider === "telegram") return `999999999:${suffix}`;
	return `clawdi_${suffix}`;
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
