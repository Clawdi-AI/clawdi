import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EgressProfileInputBundle } from "./egress-profiles";
import type { RuntimeManifest } from "./manifest-contract";
import type {
	RuntimeChannelAccount,
	RuntimeChannelCredential,
	RuntimeChannelsLoad,
	RuntimeManifestLoad,
} from "./manifest-source";
import { WHATSAPP_UPSTREAM_READY } from "./whatsapp-gate";

type EgressProfile = EgressProfileInputBundle["profiles"][number];
type ChannelProvider = RuntimeChannelAccount["provider"];

const HERMES_MANAGED_CHANNEL_ENV = [
	"TELEGRAM_ALLOW_ALL_USERS",
	"DISCORD_ALLOW_ALL_USERS",
	"HERMES_TELEGRAM_DISABLE_FALLBACK_IPS",
	"WHATSAPP_ENABLED",
	"WHATSAPP_MODE",
	"WHATSAPP_ALLOWED_USERS",
] as const;
const HERMES_MANAGED_CHANNEL_SECRET_ENV = [
	"TELEGRAM_BOT_TOKEN",
	"DISCORD_BOT_TOKEN",
	"HERMES_WA_CREDS_JSON",
] as const;
const OPENCLAW_CHANNEL_TOKEN_ENV_PREFIX = "CLAWDI_CHANNEL_";
const OPENCLAW_CHANNEL_TOKEN_ENV_SUFFIX = "_AGENT_TOKEN";

interface ManagedChannelLink {
	account: RuntimeChannelAccount;
	accountKey: string;
	linkId: string;
	agentId: string;
	agentToken: string;
	secretRef: string;
	placeholderSecretRef: string;
	credentials: RuntimeChannelCredential[];
}

interface OpenClawEnvSecretRef {
	source: "env";
	provider: "default";
	id: string;
}

interface RuntimeChannelCredentialProjection {
	provider: "whatsapp";
	kind: "whatsapp_baileys_auth_state";
	accountId: string;
	accountKey: string;
	linkId: string;
	credentialId: string;
	authDir: string;
	files: {
		path: "creds.json";
		secretRef: string;
	}[];
	targets: {
		openclaw?: {
			authDir: string;
		};
		hermes?: {
			sessionDir: string;
			credsJsonEnv: "HERMES_WA_CREDS_JSON";
		};
	};
}

export function applyRuntimeChannelsToManifestLoad(
	load: RuntimeManifestLoad,
	channels: RuntimeChannelsLoad | null,
): RuntimeManifestLoad {
	if (!channels) return load;
	const managedLinks = managedChannelLinks(channels.channels);
	const manifest = applyRuntimeChannelProjection(load.manifest, managedLinks);
	const localSecretValues = {
		...(load.localSecretValues ?? {}),
		...channelSecretValues(managedLinks, manifest.projection?.channelCredentials),
	};
	return {
		...load,
		manifest,
		sourceManifest: load.sourceManifest ?? load.manifest,
		localSecretValues: Object.keys(localSecretValues).length > 0 ? localSecretValues : undefined,
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
				placeholderSecretRef: channelPlaceholderSecretRef(account.provider, accountKey),
				credentials: (account.runtime_credentials ?? []).filter(
					(credential) => credential.agent_link_id === link.id,
				),
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
	const managedProfiles = buildManagedChannelEgressProfiles(links, manifest.controlPlane.apiUrl);
	const runtimeHome = runtimeProjectionHome(manifest);
	const channelCredentials = buildRuntimeChannelCredentialsProjection(
		links,
		runtimeHome,
		runtimeCredentialTargets(manifest),
	);
	const projected: RuntimeManifest = {
		...manifest,
		projection: {
			...(manifest.projection ?? {}),
			channels: buildOpenClawChannelsProjection(links, manifest.controlPlane.apiUrl, runtimeHome),
			channelCredentials,
		},
		egressProfiles: mergeEgressProfiles(manifest.egressProfiles, managedProfiles),
	};
	return applyHermesRuntimeChannelSettings(
		applyOpenClawRuntimeChannelSettings(projected, links),
		links,
	);
}

function buildOpenClawChannelsProjection(
	links: ManagedChannelLink[],
	cloudApiUrl: string,
	runtimeHome: string,
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
		if (provider === "whatsapp") {
			const channel = ensureAccountChannel(channels, "whatsapp", link.accountKey);
			const credential = whatsappBaileysCredentialProjection(link, runtimeHome, {
				openclaw: true,
				hermes: false,
			});
			channel.accounts[link.accountKey] = {
				enabled: true,
				wsUrl: `${toWebSocketUrl(stripTrailingSlash(cloudApiUrl))}/v1/channels/whatsapp/${link.account.id}/baileys`,
				token: openClawChannelPlaceholderTokenSecretRef(link),
				...(credential ? { authDir: credential.authDir } : {}),
			};
		}
	}
	return channels;
}

function buildRuntimeChannelCredentialsProjection(
	links: ManagedChannelLink[],
	runtimeHome: string,
	targets: RuntimeCredentialTargets,
): RuntimeChannelCredentialProjection[] {
	return links
		.map((link) => whatsappBaileysCredentialProjection(link, runtimeHome, targets))
		.filter((credential): credential is RuntimeChannelCredentialProjection => credential !== null)
		.sort((left, right) =>
			`${left.provider}:${left.accountKey}:${left.credentialId}`.localeCompare(
				`${right.provider}:${right.accountKey}:${right.credentialId}`,
			),
		);
}

function applyOpenClawRuntimeChannelSettings(
	manifest: RuntimeManifest,
	links: ManagedChannelLink[],
): RuntimeManifest {
	const openclaw = manifest.runtimes.openclaw;
	if (!openclaw?.enabled) return manifest;

	const existingRun = openclaw.run ?? { env: {}, prependPath: [] };
	const secretEnv = omitOpenClawManagedChannelSecretEnv(existingRun.secretEnv ?? {});
	for (const link of links) {
		if (link.account.provider === "whatsapp" && !WHATSAPP_UPSTREAM_READY) continue;
		secretEnv[openClawChannelTokenEnvName(link)] = link.placeholderSecretRef;
	}
	if (!openclaw.run && Object.keys(secretEnv).length === 0) {
		return manifest;
	}

	return {
		...manifest,
		runtimes: {
			...manifest.runtimes,
			openclaw: {
				...openclaw,
				run: {
					...existingRun,
					secretEnv,
				},
			},
		},
	};
}

function applyHermesRuntimeChannelSettings(
	manifest: RuntimeManifest,
	links: ManagedChannelLink[],
): RuntimeManifest {
	const hermes = manifest.runtimes.hermes;
	if (!hermes?.enabled) return manifest;

	const telegram = firstLinkForProvider(links, "telegram");
	const discord = firstLinkForProvider(links, "discord");
	const whatsapp = WHATSAPP_UPSTREAM_READY ? firstLinkForProvider(links, "whatsapp") : null;
	const whatsappCredentials = whatsapp ? whatsappBaileysCredentials(whatsapp) : [];
	const whatsappCredential = whatsappCredentials.find(
		(credential) => whatsappCredentialCreds(credential) !== null,
	);
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
	if (whatsapp && whatsappCredential) {
		env.WHATSAPP_ENABLED = "true";
		env.WHATSAPP_MODE = "bot";
		env.WHATSAPP_ALLOWED_USERS = "*";
		secretEnv.HERMES_WA_CREDS_JSON = whatsappBaileysCredsJsonSecretRef(
			whatsapp,
			whatsappCredential,
		);
	}

	return {
		...manifest,
		runtimes: {
			...manifest.runtimes,
			hermes: {
				...hermes,
				run: {
					...existingRun,
					env,
					secretEnv,
				},
			},
		},
	};
}

function firstLinkForProvider(
	links: ManagedChannelLink[],
	provider: ChannelProvider,
): ManagedChannelLink | null {
	return links.find((link) => link.account.provider === provider) ?? null;
}

function openClawChannelPlaceholderTokenSecretRef(link: ManagedChannelLink): OpenClawEnvSecretRef {
	return {
		source: "env",
		provider: "default",
		id: openClawChannelTokenEnvName(link),
	};
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

function buildManagedChannelEgressProfiles(
	links: ManagedChannelLink[],
	cloudApiUrl: string,
): EgressProfile[] {
	const baseUrl = stripTrailingSlash(cloudApiUrl);
	const profiles: EgressProfile[] = [];
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
						secretRef: link.placeholderSecretRef,
						prefix: "/bot",
						suffix: "/",
					},
					headers: {},
					query: {},
				},
				rewrite: {
					upstreamBaseUrl: `${baseUrl}/v1/channels/telegram`,
					preservePath: true,
					pathReplace: {
						type: "secretRefPrefix",
						secretRef: link.placeholderSecretRef,
						replacementSecretRef: link.secretRef,
						prefix: "/bot",
						suffix: "/",
					},
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
					// Discord's own REST prefix (discord.com/api/v10/...) — external
					// URL shape, not a clawdi-cloud API path; keep it /api/.
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
							secretRef: link.placeholderSecretRef,
							prefix: "Bearer ",
						},
					},
					query: {},
				},
				rewrite: {
					upstreamBaseUrl: `${baseUrl}/v1/channels/whatsapp/graph`,
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
				priority: 102,
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

function channelSecretValues(
	links: ManagedChannelLink[],
	channelCredentials: unknown,
): Record<string, string> {
	const values: Record<string, string> = {};
	const projectedCredentialSecrets = projectedWhatsAppCredentialSecretRefs(channelCredentials);
	for (const link of links) {
		addSecretValue(values, link.secretRef, link.agentToken);
		addSecretValue(
			values,
			link.placeholderSecretRef,
			channelPlaceholderToken(link.account.provider, link.accountKey),
		);
		for (const credential of whatsappBaileysCredentials(link)) {
			const creds = whatsappCredentialCreds(credential);
			if (creds === null) continue;
			const secretRef = whatsappBaileysCredsJsonSecretRef(link, credential);
			if (!projectedCredentialSecrets.has(secretRef)) continue;
			addSecretValue(values, secretRef, JSON.stringify(creds));
		}
	}
	return values;
}

function projectedWhatsAppCredentialSecretRefs(channelCredentials: unknown): Set<string> {
	const refs = new Set<string>();
	if (!Array.isArray(channelCredentials)) return refs;
	for (const credential of channelCredentials) {
		const record = recordValue(credential);
		if (record?.provider !== "whatsapp" || record.kind !== "whatsapp_baileys_auth_state") {
			continue;
		}
		const files = Array.isArray(record.files) ? record.files : [];
		for (const file of files) {
			const fileRecord = recordValue(file);
			const secretRef = stringValue(fileRecord?.secretRef);
			if (fileRecord?.path === "creds.json" && secretRef) refs.add(secretRef);
		}
	}
	return refs;
}

function addSecretValue(values: Record<string, string>, ref: string, value: string): void {
	values[ref] = value;
	values[ref.replace(/^secret:\/\//, "")] = value;
}

function channelSecretRef(provider: ChannelProvider, accountKey: string): string {
	return `secret://channels/${provider}/${accountKey}/agent-token`;
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

function whatsappBaileysCredentialProjection(
	link: ManagedChannelLink,
	runtimeHome: string,
	targets: RuntimeCredentialTargets,
): RuntimeChannelCredentialProjection | null {
	if (!WHATSAPP_UPSTREAM_READY) return null;
	const credential = whatsappBaileysCredentials(link)[0];
	if (!credential || whatsappCredentialCreds(credential) === null) return null;
	const openclawAuthDir = openClawWhatsAppAuthDir(runtimeHome, link.accountKey);
	const targetProjection: RuntimeChannelCredentialProjection["targets"] = {};
	if (targets.openclaw) {
		targetProjection.openclaw = { authDir: openclawAuthDir };
	}
	if (targets.hermes) {
		targetProjection.hermes = {
			sessionDir: hermesWhatsAppSessionDir(runtimeHome),
			credsJsonEnv: "HERMES_WA_CREDS_JSON",
		};
	}
	if (!targetProjection.openclaw && !targetProjection.hermes) return null;
	return {
		provider: "whatsapp",
		kind: "whatsapp_baileys_auth_state",
		accountId: link.account.id,
		accountKey: link.accountKey,
		linkId: link.linkId,
		credentialId: credential.id,
		authDir: openclawAuthDir,
		files: [
			{
				path: "creds.json",
				secretRef: whatsappBaileysCredsJsonSecretRef(link, credential),
			},
		],
		targets: targetProjection,
	};
}

function whatsappBaileysCredentials(link: ManagedChannelLink): RuntimeChannelCredential[] {
	if (link.account.provider !== "whatsapp") return [];
	return link.credentials.filter(
		(credential) =>
			credential.provider === "whatsapp" && credential.kind === "whatsapp_baileys_auth_state",
	);
}

function whatsappCredentialCreds(credential: RuntimeChannelCredential): unknown | null {
	const material = recordValue(credential.material);
	if (material?.schemaVersion !== "clawdi.whatsappBaileysAuthState.v1") {
		return null;
	}
	const creds = material.creds;
	if (!creds || typeof creds !== "object" || Array.isArray(creds)) return null;
	return creds;
}

function whatsappBaileysCredsJsonSecretRef(
	link: ManagedChannelLink,
	credential: RuntimeChannelCredential,
): string {
	return `secret://channels/whatsapp/${link.accountKey}/credentials/${credential.id}/creds-json`;
}

function openClawWhatsAppAuthDir(runtimeHome: string, accountKey: string): string {
	return join(runtimeHome, ".openclaw", "credentials", "whatsapp", accountKey);
}

function hermesWhatsAppSessionDir(runtimeHome: string): string {
	return join(runtimeHome, ".hermes", "platforms", "whatsapp", "session");
}

interface RuntimeCredentialTargets {
	openclaw: boolean;
	hermes: boolean;
}

function runtimeCredentialTargets(manifest: RuntimeManifest): RuntimeCredentialTargets {
	return {
		openclaw: manifest.runtimes.openclaw?.enabled === true,
		hermes: manifest.runtimes.hermes?.enabled === true,
	};
}

function runtimeProjectionHome(manifest: RuntimeManifest): string {
	const system = recordValue(manifest.projection?.system);
	const home = system ? stringValue(system.home) : null;
	return home ?? process.env.HOME ?? "/home/clawdi";
}

function recordValue(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
