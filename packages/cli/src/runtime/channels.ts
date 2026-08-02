import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EgressProfileInputBundle } from "./egress-profiles";
import type { RuntimeManifest } from "./manifest-contract";
import type {
	RuntimeBundleChannelBinding,
	RuntimeChannelAccount,
	RuntimeChannelCredential,
	RuntimeChannelsLoad,
	RuntimeManifestLoad,
} from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import { runtimeSecretValue } from "./secret-values";
import { buildManagedWhatsAppEgressProfiles } from "./whatsapp-egress";
import { WHATSAPP_UPSTREAM_READY } from "./whatsapp-gate";

type EgressProfile = EgressProfileInputBundle["profiles"][number];
type ChannelProvider = RuntimeChannelAccount["provider"];

const HERMES_MANAGED_CHANNEL_ENV = [
	"TELEGRAM_ALLOW_ALL_USERS",
	"DISCORD_ALLOW_ALL_USERS",
	"HERMES_TELEGRAM_DISABLE_FALLBACK_IPS",
] as const;
const HERMES_MANAGED_CHANNEL_SECRET_ENV = ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"] as const;
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
		path: "creds.json" | ".clawdi-managed-whatsapp-socket.json";
		secretRef: string;
	}[];
	targets: {
		openclaw?: {
			authDir: string;
		};
		hermes?: {
			authDir: string;
		};
	};
}

interface WhatsAppBaileysCredentialMaterial {
	credential: RuntimeChannelCredential;
	creds: Record<string, unknown>;
	authCert: {
		SERIAL: number;
		ISSUER: string;
		PUBLIC_KEY: { type: "Buffer"; data: string };
	};
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
		...channelSecretValues(managedLinks, manifest.projection?.channelCredentials),
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
	const links: ManagedChannelLink[] = load.channelBindings.map((binding) =>
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
		credentials: [],
	};
}

function managedChannelLinks(channels: RuntimeChannelAccount[]): ManagedChannelLink[] {
	const links: ManagedChannelLink[] = [];
	for (const account of channels) {
		if (account.status !== "active") continue;
		if (account.provider === "whatsapp" && !WHATSAPP_UPSTREAM_READY) continue;
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
				placeholderSecretRef: channelPlaceholderSecretRef(account.provider, accountKey, link.id),
				credentials: (account.runtime_credentials ?? []).filter(
					(credential) => credential.agent_link_id === link.id,
				),
			});
		}
	}
	return links.sort((left, right) =>
		`${left.account.provider}:${left.accountKey}:${left.linkId}`.localeCompare(
			`${right.account.provider}:${right.accountKey}:${right.linkId}`,
		),
	);
}

function applyRuntimeChannelProjection(
	manifest: RuntimeManifest,
	links: ManagedChannelLink[],
	paths: RuntimePaths,
): RuntimeManifest {
	const managedProfiles = buildManagedChannelEgressProfiles(links, manifest.controlPlane.apiUrl);
	const runtimeHome = hostedRuntimeProjectionHome(manifest, paths);
	const credentialTargets = runtimeCredentialTargets(manifest);
	const channelCredentials = buildRuntimeChannelCredentialsProjection(
		links,
		runtimeHome,
		credentialTargets,
	);
	const projected: RuntimeManifest = {
		...manifest,
		projection: {
			...(manifest.projection ?? {}),
			channels: buildOpenClawChannelsProjection(links, runtimeHome, credentialTargets),
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
	runtimeHome: string,
	targets: RuntimeCredentialTargets,
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
				// The managed invite also grants public-thread creation for runtime
				// workflows such as forum posts and thread-bound sessions. OpenClaw's
				// broader thread action tool also exposes listing/reply operations, so
				// keep that optional tool surface disabled; ordinary thread delivery and
				// supported runtime-managed creation continue through their own paths.
				actions: {
					stickers: false,
					polls: false,
					threads: false,
					pins: false,
					roles: false,
					voiceStatus: false,
					events: false,
					moderation: false,
					emojiUploads: false,
					stickerUploads: false,
					channels: false,
					presence: false,
				},
			};
			continue;
		}
		if (provider === "whatsapp") {
			const channel = ensureAccountChannel(channels, "whatsapp", link.accountKey);
			const credential = whatsappBaileysCredentialProjection(link, runtimeHome, targets);
			channel.accounts[link.accountKey] = {
				enabled: true,
				...(credential?.targets.openclaw ? { authDir: credential.targets.openclaw.authDir } : {}),
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
	assertSingleManagedLinkPerProvider(links);

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

function singleLinkForProvider(
	links: ManagedChannelLink[],
	provider: ChannelProvider,
): ManagedChannelLink | null {
	const matching = links.filter((link) => link.account.provider === provider);
	if (matching.length > 1) {
		throw new Error(runtimeProviderLinkLimitDetail(provider));
	}
	return matching[0] ?? null;
}

function assertSingleManagedLinkPerProvider(links: ManagedChannelLink[]): void {
	for (const provider of ["telegram", "discord", "whatsapp"] as const) {
		singleLinkForProvider(links, provider);
	}
}

function runtimeProviderLinkLimitDetail(provider: ChannelProvider): string {
	const label =
		provider === "telegram" ? "Telegram" : provider === "discord" ? "Discord" : provider;
	return `This Agent has multiple active ${label} bots. Unlink the extras until only one remains.`;
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
	const whatsapp = singleLinkForProvider(links, "whatsapp");
	if (whatsapp) {
		const material = whatsappBaileysCredentialMaterial(whatsapp);
		if (!material) {
			throw new Error(`managed WhatsApp Link ${whatsapp.linkId} has no valid synthetic auth`);
		}
		profiles.push(
			...buildManagedWhatsAppEgressProfiles({
				controlPlaneApiUrl: cloudApiUrl,
				links: [
					{
						linkId: whatsapp.linkId,
						agentTokenSecretRef: whatsapp.secretRef,
						capabilitySecretRef: whatsapp.placeholderSecretRef,
					},
				],
			}),
		);
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
			channelPlaceholderToken(link.account.provider, link.accountKey, link.linkId),
		);
		const material = whatsappBaileysCredentialMaterial(link);
		if (material) {
			const credsSecretRef = whatsappBaileysCredsJsonSecretRef(link, material.credential);
			if (projectedCredentialSecrets.has(credsSecretRef)) {
				addSecretValue(values, credsSecretRef, JSON.stringify(material.creds));
			}
			const socketSecretRef = whatsappManagedSocketSecretRef(link, material.credential);
			if (projectedCredentialSecrets.has(socketSecretRef)) {
				addSecretValue(
					values,
					socketSecretRef,
					JSON.stringify({
						schemaVersion: "clawdi.managedWhatsAppSocket.v1",
						capability: channelPlaceholderToken(
							link.account.provider,
							link.accountKey,
							link.linkId,
						),
						authCert: material.authCert,
					}),
				);
			}
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
			if (
				(fileRecord?.path === "creds.json" ||
					fileRecord?.path === ".clawdi-managed-whatsapp-socket.json") &&
				secretRef
			) {
				refs.add(secretRef);
			}
		}
	}
	return refs;
}

function addSecretValue(values: Record<string, string>, ref: string, value: string): void {
	values[ref] = value;
}

function channelLinkSecretRef(
	provider: ChannelProvider,
	accountKey: string,
	linkId: string,
): string {
	return `secret://channels/${provider}/${accountKey}/links/${linkId}/agent-token`;
}

function channelPlaceholderSecretRef(
	provider: ChannelProvider,
	accountKey: string,
	linkId?: string,
): string {
	if (provider === "whatsapp") {
		if (!linkId) throw new Error("managed WhatsApp capability requires a Link id");
		return `secret://channels/whatsapp/${accountKey}/links/${linkId}/egress-capability`;
	}
	return `secret://channels/${provider}/${accountKey}/placeholder-token`;
}

function channelPlaceholderToken(
	provider: ChannelProvider,
	accountKey: string,
	linkId?: string,
): string {
	const suffix = createHash("sha256")
		.update(`${provider}:${accountKey}${provider === "whatsapp" ? `:${linkId ?? ""}` : ""}`)
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
	const material = whatsappBaileysCredentialMaterial(link);
	if (!material) return null;
	const openclawAuthDir = openClawWhatsAppAuthDir(runtimeHome, link.accountKey);
	const hermesAuthDir = hermesWhatsAppAuthDir(runtimeHome);
	const targetProjection: RuntimeChannelCredentialProjection["targets"] = {};
	if (targets.openclaw) {
		targetProjection.openclaw = { authDir: openclawAuthDir };
	}
	if (targets.hermes) {
		targetProjection.hermes = { authDir: hermesAuthDir };
	}
	const primaryAuthDir = targetProjection.openclaw?.authDir ?? targetProjection.hermes?.authDir;
	if (!primaryAuthDir) return null;
	return {
		provider: "whatsapp",
		kind: "whatsapp_baileys_auth_state",
		accountId: link.account.id,
		accountKey: link.accountKey,
		linkId: link.linkId,
		credentialId: material.credential.id,
		authDir: primaryAuthDir,
		files: [
			{
				path: "creds.json",
				secretRef: whatsappBaileysCredsJsonSecretRef(link, material.credential),
			},
			{
				path: ".clawdi-managed-whatsapp-socket.json",
				secretRef: whatsappManagedSocketSecretRef(link, material.credential),
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

function whatsappBaileysCredentialMaterial(
	link: ManagedChannelLink,
): WhatsAppBaileysCredentialMaterial | null {
	const credential = whatsappBaileysCredentials(link)[0];
	if (!credential) return null;
	const material = recordValue(credential.material);
	if (material?.schemaVersion !== "clawdi.whatsappBaileysAuthState.v1") {
		return null;
	}
	const creds = recordValue(material.creds);
	const authCert = recordValue(material.authCert);
	const serial = authCert?.SERIAL;
	const issuer = stringValue(authCert?.ISSUER);
	const publicKey = recordValue(authCert?.PUBLIC_KEY);
	const publicKeyData = stringValue(publicKey?.data);
	if (
		!creds ||
		typeof serial !== "number" ||
		!Number.isSafeInteger(serial) ||
		serial < 0 ||
		!issuer ||
		publicKey?.type !== "Buffer" ||
		!publicKeyData ||
		!isCanonicalBase64(publicKeyData, 32)
	) {
		return null;
	}
	return {
		credential,
		creds,
		authCert: {
			SERIAL: serial,
			ISSUER: issuer,
			PUBLIC_KEY: { type: "Buffer", data: publicKeyData },
		},
	};
}

function isCanonicalBase64(value: string, byteLength: number): boolean {
	try {
		const decoded = Buffer.from(value, "base64");
		return decoded.length === byteLength && decoded.toString("base64") === value;
	} catch {
		return false;
	}
}

function whatsappBaileysCredsJsonSecretRef(
	link: ManagedChannelLink,
	credential: RuntimeChannelCredential,
): string {
	return `secret://channels/whatsapp/${link.accountKey}/credentials/${credential.id}/creds-json`;
}

function whatsappManagedSocketSecretRef(
	link: ManagedChannelLink,
	credential: RuntimeChannelCredential,
): string {
	return `secret://channels/whatsapp/${link.accountKey}/credentials/${credential.id}/managed-socket`;
}

function openClawWhatsAppAuthDir(runtimeHome: string, accountKey: string): string {
	return join(runtimeHome, ".openclaw", "credentials", "whatsapp", accountKey);
}

function hermesWhatsAppAuthDir(runtimeHome: string): string {
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
