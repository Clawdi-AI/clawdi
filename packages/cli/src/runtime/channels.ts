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
import { CLAWDI_WHATSAPP_LINK_CAPABILITY_ENV } from "./whatsapp-upstream-contract";

type EgressProfile = EgressProfileInputBundle["profiles"][number];
type ChannelProvider = RuntimeChannelAccount["provider"];

const HERMES_MANAGED_CHANNEL_ENV = [
	"TELEGRAM_ALLOW_ALL_USERS",
	"DISCORD_ALLOW_ALL_USERS",
	"HERMES_TELEGRAM_DISABLE_FALLBACK_IPS",
] as const;
const HERMES_MANAGED_WHATSAPP_ENV = [
	"WHATSAPP_ENABLED",
	"WHATSAPP_MODE",
	"WHATSAPP_ALLOWED_USERS",
] as const;
const HERMES_MANAGED_CHANNEL_SECRET_ENV = ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"] as const;
const HERMES_MANAGED_WHATSAPP_SECRET_ENV = [
	"HERMES_WA_CREDS_JSON",
	CLAWDI_WHATSAPP_LINK_CAPABILITY_ENV,
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
	capabilitySecretRef: string | null;
	capability: string | null;
	capabilityExpiresAt: string | null;
	credentialGeneration: number | null;
	credentialSecretRef: string | null;
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
	generation: number;
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
	const secretValues = { ...(load.secretValues ?? {}) };
	const enabledBindings = load.channelBindings.filter(
		(binding) => binding.provider !== "whatsapp" || WHATSAPP_UPSTREAM_READY,
	);
	for (const binding of load.channelBindings) {
		if (binding.provider !== "whatsapp" || WHATSAPP_UPSTREAM_READY) continue;
		for (const ref of [
			binding.agentTokenSecretRef,
			binding.capabilitySecretRef,
			binding.credentialSecretRef,
		]) {
			delete secretValues[ref];
		}
	}
	const links = enabledBindings.map((binding) => managedBundleChannelLink(binding, secretValues));
	return {
		...load,
		manifest: applyRuntimeChannelProjection(load.manifest, links, paths),
		sourceManifest: load.sourceManifest ?? load.manifest,
		secretValues:
			load.secretValues !== undefined || Object.keys(secretValues).length > 0
				? secretValues
				: undefined,
		channelBindings: enabledBindings,
	};
}

function managedBundleChannelLink(
	binding: RuntimeBundleChannelBinding,
	secretValues: Record<string, string>,
): ManagedChannelLink {
	const agentToken = runtimeSecretValue(secretValues, binding.agentTokenSecretRef);
	if (!agentToken) throw new Error(`runtime bundle is missing ${binding.agentTokenSecretRef}`);
	if (binding.provider === "whatsapp") {
		const capability = runtimeSecretValue(secretValues, binding.capabilitySecretRef);
		const credentialJson = runtimeSecretValue(secretValues, binding.credentialSecretRef);
		if (!capability) {
			throw new Error(`runtime bundle is missing ${binding.capabilitySecretRef}`);
		}
		if (!credentialJson) {
			throw new Error(`runtime bundle is missing ${binding.credentialSecretRef}`);
		}
		let creds: unknown;
		try {
			creds = JSON.parse(credentialJson) as unknown;
		} catch (error) {
			throw new Error(
				`runtime bundle has invalid WhatsApp credential ${binding.credentialSecretRef}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		if (!recordValue(creds)) {
			throw new Error(
				`runtime bundle has invalid WhatsApp credential ${binding.credentialSecretRef}`,
			);
		}
		return {
			account: {
				id: binding.accountId,
				provider: "whatsapp",
				name: binding.accountKey,
				status: "active",
				visibility: "private",
				runtime_links: [],
				runtime_credentials: [],
			},
			accountKey: binding.accountKey,
			linkId: binding.linkId,
			agentId: "bundle",
			agentToken,
			secretRef: binding.agentTokenSecretRef,
			placeholderSecretRef: binding.capabilitySecretRef,
			capabilitySecretRef: binding.capabilitySecretRef,
			capability,
			capabilityExpiresAt: binding.capabilityExpiresAt,
			credentialGeneration: binding.generation,
			credentialSecretRef: binding.credentialSecretRef,
			credentials: [
				{
					id: binding.credentialId,
					account_id: binding.accountId,
					agent_link_id: binding.linkId,
					agent_id: "bundle",
					provider: "whatsapp",
					kind: "whatsapp_baileys_auth_state",
					material: {
						schemaVersion: "clawdi.whatsappBaileysAuthState.v1",
						creds,
					},
				},
			],
		};
	}
	const placeholderToken = runtimeSecretValue(secretValues, binding.placeholderTokenSecretRef);
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
		capabilitySecretRef: null,
		capability: null,
		capabilityExpiresAt: null,
		credentialGeneration: null,
		credentialSecretRef: null,
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
				placeholderSecretRef: channelPlaceholderSecretRef(account.provider, accountKey),
				capabilitySecretRef:
					account.provider === "whatsapp"
						? channelWhatsAppCapabilitySecretRef(accountKey, link.id)
						: null,
				capability:
					account.provider === "whatsapp"
						? channelWhatsAppCapability(link.agent_token, link.id)
						: null,
				capabilityExpiresAt: null,
				credentialGeneration: null,
				credentialSecretRef: null,
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
	const channelCredentials = buildRuntimeChannelCredentialsProjection(
		links,
		runtimeHome,
		runtimeCredentialTargets(manifest),
	);
	const projected: RuntimeManifest = {
		...manifest,
		projection: {
			...(manifest.projection ?? {}),
			channels: buildOpenClawChannelsProjection(links, runtimeHome),
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
	assertSingleManagedLinkPerProvider(links);

	const existingRun = openclaw.run ?? { env: {}, prependPath: [] };
	const secretEnv = omitOpenClawManagedChannelSecretEnv(existingRun.secretEnv ?? {});
	for (const link of links) {
		if (link.account.provider === "whatsapp" && !WHATSAPP_UPSTREAM_READY) continue;
		if (link.account.provider === "whatsapp") {
			if (!link.capabilitySecretRef || !link.capabilityExpiresAt) {
				throw new Error("managed WhatsApp Link is missing its egress capability");
			}
			secretEnv[CLAWDI_WHATSAPP_LINK_CAPABILITY_ENV] = link.capabilitySecretRef;
			continue;
		}
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
	const whatsapp = WHATSAPP_UPSTREAM_READY ? singleLinkForProvider(links, "whatsapp") : null;
	const whatsappCredentials = whatsapp ? whatsappBaileysCredentials(whatsapp) : [];
	const whatsappCredential = whatsappCredentials.find(
		(credential) => whatsappCredentialCreds(credential) !== null,
	);
	const existingRun = hermes.run ?? { env: {}, prependPath: [] };
	const env = omitKeys(existingRun.env ?? {}, [
		...HERMES_MANAGED_CHANNEL_ENV,
		...(WHATSAPP_UPSTREAM_READY ? HERMES_MANAGED_WHATSAPP_ENV : []),
	]);
	const secretEnv = omitKeys(existingRun.secretEnv ?? {}, [
		...HERMES_MANAGED_CHANNEL_SECRET_ENV,
		...(WHATSAPP_UPSTREAM_READY ? HERMES_MANAGED_WHATSAPP_SECRET_ENV : []),
	]);

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
		if (!whatsapp.capabilitySecretRef || !whatsapp.capabilityExpiresAt) {
			throw new Error("managed WhatsApp Link is missing its egress capability");
		}
		env.WHATSAPP_ENABLED = "true";
		env.WHATSAPP_MODE = "bot";
		env.WHATSAPP_ALLOWED_USERS = "*";
		secretEnv.HERMES_WA_CREDS_JSON = whatsappBaileysCredsJsonSecretRef(
			whatsapp,
			whatsappCredential,
		);
		secretEnv[CLAWDI_WHATSAPP_LINK_CAPABILITY_ENV] = whatsapp.capabilitySecretRef;
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
		key === CLAWDI_WHATSAPP_LINK_CAPABILITY_ENV ||
		(key.startsWith(OPENCLAW_CHANNEL_TOKEN_ENV_PREFIX) &&
			key.endsWith(OPENCLAW_CHANNEL_TOKEN_ENV_SUFFIX))
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
	profiles.push(
		...buildManagedWhatsAppEgressProfiles({
			cloudApiUrl,
			links: links.flatMap((link) =>
				link.account.provider === "whatsapp" && link.capabilitySecretRef && link.capabilityExpiresAt
					? [
							{
								linkId: link.linkId,
								agentTokenSecretRef: link.secretRef,
								capabilitySecretRef: link.capabilitySecretRef,
								capabilityExpiresAt: link.capabilityExpiresAt,
							},
						]
					: [],
			),
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

function channelSecretValues(
	links: ManagedChannelLink[],
	channelCredentials: unknown,
): Record<string, string> {
	const values: Record<string, string> = {};
	const projectedCredentialSecrets = projectedWhatsAppCredentialSecretRefs(channelCredentials);
	for (const link of links) {
		addSecretValue(values, link.secretRef, link.agentToken);
		if (link.capabilitySecretRef && link.capability) {
			addSecretValue(values, link.capabilitySecretRef, link.capability);
		}
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

function channelWhatsAppCapabilitySecretRef(accountKey: string, linkId: string): string {
	return `secret://channels/whatsapp/${accountKey}/links/${linkId}/egress-capability`;
}

function channelWhatsAppCapability(agentToken: string, linkId: string): string {
	return createHash("sha256")
		.update("clawdi-whatsapp-link-capability-v1\0")
		.update(linkId)
		.update("\0")
		.update(agentToken)
		.digest("base64url");
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
		generation: link.credentialGeneration ?? 1,
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
	if (link.credentialSecretRef) return link.credentialSecretRef;
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
