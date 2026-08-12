import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EgressProfileInputBundle } from "./egress-profiles";
import type { RuntimeManifest } from "./manifest-contract";
import type { RuntimeBundleChannelBinding, RuntimeManifestLoad } from "./manifest-source";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { hostedRuntimeProjectionHome } from "./projection-home";
import { runtimeSecretValue } from "./secret-values";
import { managedWhatsAppAuthCredentials } from "./whatsapp-credential-projection";
import { buildManagedWhatsAppEgressProfiles } from "./whatsapp-egress";
import {
	CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY,
	CLAWDI_MANAGED_WHATSAPP_SOCKET_SCHEMA,
	type ManagedWhatsAppSocketMetadataJson,
	parseManagedWhatsAppSocketMetadataJson,
} from "./whatsapp-upstream-contract";

type EgressProfile = EgressProfileInputBundle["profiles"][number];
type ChannelProvider = RuntimeBundleChannelBinding["provider"];

const HERMES_MANAGED_CHANNEL_ENV = [
	"TELEGRAM_ALLOW_ALL_USERS",
	"DISCORD_ALLOW_ALL_USERS",
	"HERMES_TELEGRAM_DISABLE_FALLBACK_IPS",
	"WHATSAPP_MODE",
	"WHATSAPP_ALLOWED_USERS",
	"WHATSAPP_ALLOW_ALL_USERS",
] as const;
const HERMES_MANAGED_CHANNEL_SECRET_ENV = ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"] as const;
const OPENCLAW_CHANNEL_TOKEN_ENV_PREFIX = "CLAWDI_CHANNEL_";
const OPENCLAW_CHANNEL_TOKEN_ENV_SUFFIX = "_AGENT_TOKEN";

interface ManagedChannelAccount {
	id: string;
	provider: ChannelProvider;
}

interface ManagedChannelCredential {
	id: string;
	credsSecretRef: string;
	material: {
		schemaVersion: "clawdi.whatsappBaileysAuthState.v1";
		creds: Record<string, unknown>;
		authCert: ManagedWhatsAppSocketMetadataJson["authCert"];
	};
}

interface ManagedChannelLink {
	account: ManagedChannelAccount;
	accountKey: string;
	linkId: string;
	secretRef: string;
	placeholderSecretRef: string;
	credential?: ManagedChannelCredential;
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
			authDir: string;
		};
	};
}

interface WhatsAppBaileysCredentialMaterial {
	credential: ManagedChannelCredential;
	creds: Record<string, unknown>;
	authCert: ManagedWhatsAppSocketMetadataJson["authCert"];
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
	const manifest = applyRuntimeChannelProjection(load.manifest, links, paths);
	const whatsappSecretValues = managedWhatsAppSecretValues(
		links.filter((link) => link.account.provider === "whatsapp"),
		manifest.projection?.channelCredentials,
	);
	return {
		...load,
		manifest,
		sourceManifest: load.sourceManifest ?? load.manifest,
		secretValues: { ...secretValues, ...whatsappSecretValues },
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
	if (binding.provider === "whatsapp") {
		const expectedAgentRef = whatsappAgentTokenSecretRef(binding.accountKey, binding.linkId);
		const expectedCapabilityRef = whatsappCapabilitySecretRef(binding.accountKey, binding.linkId);
		const expectedCapability = whatsappCapabilityToken(binding.accountKey, binding.linkId);
		if (binding.agentTokenSecretRef !== expectedAgentRef) {
			throw new Error("runtime bundle WhatsApp agent token ref does not match its Link");
		}
		if (binding.placeholderTokenSecretRef !== expectedCapabilityRef) {
			throw new Error("runtime bundle WhatsApp capability ref does not match its Link");
		}
		if (placeholderToken !== expectedCapability) {
			throw new Error("runtime bundle WhatsApp capability does not match its Link");
		}
	}
	return {
		account: {
			id: binding.provider === "whatsapp" ? binding.accountId : binding.accountKey,
			provider: binding.provider,
		},
		accountKey: binding.accountKey,
		linkId: binding.provider === "whatsapp" ? binding.linkId : binding.accountKey,
		secretRef: binding.agentTokenSecretRef,
		placeholderSecretRef: binding.placeholderTokenSecretRef,
		credential:
			binding.provider === "whatsapp"
				? runtimeBundleWhatsAppCredential(binding, secretValues)
				: undefined,
	};
}

function runtimeBundleWhatsAppCredential(
	binding: Extract<RuntimeBundleChannelBinding, { provider: "whatsapp" }>,
	secretValues: Record<string, string>,
): ManagedChannelCredential {
	const secretRef = binding.credential.credsSecretRef;
	const expectedSecretRef = whatsappCredentialSecretRef(binding.accountKey, binding.credential.id);
	if (secretRef !== expectedSecretRef) {
		throw new Error("runtime bundle WhatsApp credential ref does not match its credential");
	}
	const rawCreds = runtimeSecretValue(secretValues, secretRef);
	if (!rawCreds) throw new Error(`runtime bundle is missing ${secretRef}`);
	let creds: unknown;
	try {
		creds = JSON.parse(rawCreds);
	} catch (error) {
		throw new Error(
			`runtime bundle WhatsApp credential is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const parsedCreds = recordValue(creds);
	if (!parsedCreds) {
		throw new Error("runtime bundle WhatsApp credential must be a JSON object");
	}
	return {
		id: binding.credential.id,
		credsSecretRef: secretRef,
		material: {
			schemaVersion: "clawdi.whatsappBaileysAuthState.v1",
			creds: parsedCreds,
			authCert: binding.credential.authCert,
		},
	};
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
				dmPolicy: "allowlist",
				allowFrom: ["*"],
				groupPolicy: "open",
				groupAllowFrom: ["*"],
				groups: { "*": { requireMention: false } },
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
	const whatsapp = singleLinkForProvider(links, "whatsapp");
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
	if (whatsapp) {
		env.WHATSAPP_MODE = "bot";
		env.WHATSAPP_ALLOWED_USERS = "*";
		env.WHATSAPP_ALLOW_ALL_USERS = "true";
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
	if (whatsapp && !whatsappBaileysCredentialMaterial(whatsapp)) {
		throw new Error(`managed WhatsApp Link ${whatsapp.linkId} has no valid synthetic auth`);
	}
	profiles.push(
		...buildManagedWhatsAppEgressProfiles({
			controlPlaneApiUrl: cloudApiUrl,
			links: whatsapp
				? [
						{
							linkId: whatsapp.linkId,
							agentTokenSecretRef: whatsapp.secretRef,
							capabilitySecretRef: whatsapp.placeholderSecretRef,
						},
					]
				: [],
		}),
	);
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
		profile.owner === "clawdi-native-whatsapp" ||
		profile.id === "direct-provider-passthrough" ||
		profile.id.startsWith("direct-provider-passthrough-")
	);
}

function managedWhatsAppSecretValues(
	links: ManagedChannelLink[],
	channelCredentials: unknown,
): Record<string, string> {
	const values: Record<string, string> = {};
	const projectedCredentialSecrets = new Set(
		managedWhatsAppAuthCredentials(channelCredentials).map(
			(credential) => credential.credsJsonSecretRef,
		),
	);
	for (const link of links) {
		const material = whatsappBaileysCredentialMaterial(link);
		if (material) {
			const credsSecretRef = material.credential.credsSecretRef;
			if (projectedCredentialSecrets.has(credsSecretRef)) {
				values[credsSecretRef] = JSON.stringify(managedWhatsAppCreds(link, material));
			}
		}
	}
	return values;
}

function whatsappAgentTokenSecretRef(accountKey: string, linkId: string): string {
	return `secret://channels/whatsapp/${accountKey}/links/${linkId}/agent-token`;
}

function whatsappCapabilitySecretRef(accountKey: string, linkId: string): string {
	return `secret://channels/whatsapp/${accountKey}/links/${linkId}/egress-capability`;
}

function whatsappCredentialSecretRef(accountKey: string, credentialId: string): string {
	return `secret://channels/whatsapp/${accountKey}/credentials/${credentialId}/creds-json`;
}

function whatsappCapabilityToken(accountKey: string, linkId: string): string {
	const suffix = createHash("sha256")
		.update(`whatsapp:${accountKey}:${linkId}`)
		.digest("hex")
		.slice(0, 32);
	return `clawdi_${suffix}`;
}

function whatsappBaileysCredentialProjection(
	link: ManagedChannelLink,
	runtimeHome: string,
	targets: RuntimeCredentialTargets,
): RuntimeChannelCredentialProjection | null {
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
				secretRef: material.credential.credsSecretRef,
			},
		],
		targets: targetProjection,
	};
}

function whatsappBaileysCredentialMaterial(
	link: ManagedChannelLink,
): WhatsAppBaileysCredentialMaterial | null {
	if (link.account.provider !== "whatsapp") return null;
	const credential = link.credential;
	if (!credential) return null;
	const { material } = credential;
	let metadata: ManagedWhatsAppSocketMetadataJson;
	try {
		metadata = parseManagedWhatsAppSocketMetadataJson({
			schemaVersion: CLAWDI_MANAGED_WHATSAPP_SOCKET_SCHEMA,
			capability: whatsappCapabilityToken(link.accountKey, link.linkId),
			authCert: material.authCert,
		});
	} catch {
		return null;
	}
	return {
		credential,
		creds: material.creds,
		authCert: metadata.authCert,
	};
}

function managedWhatsAppCreds(
	link: ManagedChannelLink,
	material: WhatsAppBaileysCredentialMaterial,
): Record<string, unknown> {
	const existingAdditionalData = material.creds.additionalData;
	const additionalData =
		existingAdditionalData === undefined ? {} : recordValue(existingAdditionalData);
	if (!additionalData) {
		throw new Error("managed WhatsApp synthetic creds.additionalData must be an object");
	}
	const metadata = parseManagedWhatsAppSocketMetadataJson({
		schemaVersion: CLAWDI_MANAGED_WHATSAPP_SOCKET_SCHEMA,
		capability: whatsappCapabilityToken(link.accountKey, link.linkId),
		authCert: material.authCert,
	});
	return {
		...material.creds,
		additionalData: {
			...additionalData,
			[CLAWDI_MANAGED_WHATSAPP_SOCKET_METADATA_KEY]: metadata,
		},
	};
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

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function toWebSocketUrl(baseUrl: string): string {
	if (baseUrl.startsWith("https://")) return `wss://${baseUrl.slice("https://".length)}`;
	if (baseUrl.startsWith("http://")) return `ws://${baseUrl.slice("http://".length)}`;
	return baseUrl;
}
