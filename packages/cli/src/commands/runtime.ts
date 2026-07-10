import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { components } from "@clawdi/shared/api";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ApiClient, unwrap } from "../lib/api-client";
import { getConfig } from "../lib/config";
import { PRIVATE_DIR_MODE, writePrivateFileAtomic } from "../lib/private-file";
import { isSemverLessThan } from "../lib/semver";
import { getCliVersion } from "../lib/version";
import { ensureRuntimeAuthTokenFile, runtimeAuthTokenFileLabel } from "../runtime/auth-token";
import { RUNTIME_BRIDGE_SURFACES_ENV, startRuntimeBridge } from "../runtime/bridge";
import { applyRuntimeChannelsToManifestLoad } from "../runtime/channels";
import {
	applyRuntimeCliDesiredState,
	completePendingRuntimeCliUpgrade,
	type RuntimeCliRollbackResult,
	type RuntimeCliUpdateResult,
	rollbackPendingRuntimeCliUpgrade,
} from "../runtime/cli-update";
import { buildEgressEngineEnv, SYSTEM_CA_BUNDLE } from "../runtime/egress-env";
import { readHostPolicy } from "../runtime/host-policy";
import {
	cacheRuntimeLastGoodManifest,
	convergeRuntimeManifest,
	loadRuntimeManifest,
	withRuntimeConvergeLock,
} from "../runtime/manifest";
import { manifestSchema as runtimeDesiredStateSchema } from "../runtime/manifest-contract";
import {
	loadRemoteRuntimeChannels,
	loadRemoteRuntimeManifest,
	type RuntimeChannelsLoad,
	type RuntimeChannelsNotModified,
	type RuntimeManifestLoad,
	type RuntimeManifestNotModified,
} from "../runtime/manifest-source";
import { detectRuntimeMode, getRuntimePaths, type RuntimePaths } from "../runtime/paths";
import {
	buildRuntimeBootStatus,
	ensureRuntimeStateDirs,
	hostPolicySummary,
	type RuntimeBootStage,
	readRuntimeBootStatus,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../runtime/state";
import {
	isGeneratedRuntimeSystemdFile,
	runtimeUserName,
	runtimeUserSystemdEnvArgs,
} from "../runtime/systemd-user";
import {
	applyTransparentEgressNftRulesFromEnv,
	cleanupTransparentEgressNftRulesFromEnv,
	loadTransparentEgressEnvConfig,
	type TransparentEgressEnvConfig,
} from "../runtime/transparent-egress";
import { WHATSAPP_UPSTREAM_READY } from "../runtime/whatsapp-gate";

type ChannelAccount = components["schemas"]["ChannelAccountResponse"];
type ChannelAccountCreate = components["schemas"]["ChannelAccountCreate"];
type ChannelAccountCreated = components["schemas"]["ChannelAccountCreatedResponse"];
type ChannelAgentLink = components["schemas"]["ChannelAgentLinkResponse"];
type ChannelCommandSpec = components["schemas"]["ChannelCommandSpec"];
type ChannelPairCode = components["schemas"]["ChannelPairCodeResponse"];
type ChannelProvider = ChannelAccountCreate["provider"];

const DOTENV_BLOCK_START = "# >>> clawdi channel runtime >>>";
const DOTENV_BLOCK_END = "# <<< clawdi channel runtime <<<";

const providerSchema = z.enum(["telegram", "discord", "whatsapp", "imessage"]);
const envNameSchema = z
	.string()
	.regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name");
const jsonObjectSchema = z.record(z.string(), z.unknown());
const secretsEnvSchema = z.record(z.string(), envNameSchema);

const accountSchema = z.union([
	z
		.object({
			id: z.string().min(1),
			visibility: z.enum(["private", "public"]).optional(),
		})
		.strict(),
	z
		.object({
			private: z
				.object({
					name: z.string().min(1),
					provider_token_env: envNameSchema.optional(),
					config: jsonObjectSchema.optional(),
					secrets_env: secretsEnvSchema.optional(),
				})
				.strict(),
		})
		.strict(),
]);

const runtimeProjectionSchema = z.enum(["dotenv"]);
const runtimeEnvKeySchema = z.enum([
	"api_base_url",
	"gateway_url",
	"websocket_url",
	"media_proxy_base_url",
	"auth_dir",
	"password",
]);

const linkSchema = z
	.object({
		ref: z.string().min(1),
		agent_id: z.string().min(1),
		runtime: z
			.object({
				token_env: envNameSchema,
				projection: runtimeProjectionSchema.default("dotenv"),
				env: z.partialRecord(runtimeEnvKeySchema, envNameSchema).optional(),
			})
			.strict(),
		pair_code: z
			.object({
				ttl_seconds: z.number().int().min(60).max(86_400).default(900),
				command_env: envNameSchema.optional(),
			})
			.strict()
			.optional(),
		whatsapp: z
			.object({
				baileys_credentials_dir: z.string().min(1).optional(),
				phone_user: z.string().min(1).optional(),
				device: z.number().int().min(1).default(1),
				name: z.string().min(1).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const channelSchema = z
	.object({
		ref: z.string().min(1),
		provider: providerSchema,
		account: accountSchema,
		links: z.array(linkSchema).min(1),
		commands: z
			.object({
				sync: z.boolean().default(false),
				guild_id: z.string().min(1).optional(),
				spec: z.array(jsonObjectSchema).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const manifestSchema = z
	.object({
		version: z.literal(1),
		channels: z.array(channelSchema).min(1),
		outputs: z
			.object({
				dotenv: z.string().min(1),
			})
			.strict(),
	})
	.strict()
	.superRefine((manifest, ctx) => {
		const channelRefs = new Set<string>();
		const linkRefs = new Set<string>();
		const envNames = new Set<string>();
		const claimEnv = (envName: string, path: (string | number)[]) => {
			if (envNames.has(envName)) {
				ctx.addIssue({
					code: "custom",
					path,
					message: `duplicate env output: ${envName}`,
				});
			}
			envNames.add(envName);
		};
		for (const [channelIndex, channel] of manifest.channels.entries()) {
			if (channelRefs.has(channel.ref)) {
				ctx.addIssue({
					code: "custom",
					path: ["channels", channelIndex, "ref"],
					message: `duplicate channel ref: ${channel.ref}`,
				});
			}
			channelRefs.add(channel.ref);
			for (const [linkIndex, link] of channel.links.entries()) {
				if (linkRefs.has(link.ref)) {
					ctx.addIssue({
						code: "custom",
						path: ["channels", channelIndex, "links", linkIndex, "ref"],
						message: `duplicate link ref: ${link.ref}`,
					});
				}
				linkRefs.add(link.ref);
				claimEnv(link.runtime.token_env, [
					"channels",
					channelIndex,
					"links",
					linkIndex,
					"runtime",
					"token_env",
				]);
				if (link.pair_code?.command_env) {
					claimEnv(link.pair_code.command_env, [
						"channels",
						channelIndex,
						"links",
						linkIndex,
						"pair_code",
						"command_env",
					]);
				}
				if (channel.provider !== "whatsapp" && link.whatsapp) {
					ctx.addIssue({
						code: "custom",
						path: ["channels", channelIndex, "links", linkIndex, "whatsapp"],
						message: "whatsapp runtime options require provider: whatsapp",
					});
				}
			}
		}
	});

type RuntimeManifest = z.infer<typeof manifestSchema>;
type RuntimeChannel = RuntimeManifest["channels"][number];
type RuntimeLink = RuntimeChannel["links"][number];

interface RuntimeCommandOptions {
	file?: string;
	json?: boolean;
}

interface RuntimeApplyOptions extends RuntimeCommandOptions {
	dryRun?: boolean;
	rotateMissingTokens?: boolean;
	rotateAllTokens?: boolean;
	yes?: boolean;
}

interface ApplyContext {
	api: ApiClient;
	manifest: RuntimeManifest;
	manifestDir: string;
	rotateMissingTokens: boolean;
	rotateAllTokens: boolean;
	env: Map<string, string>;
	actions: RuntimeAction[];
	accounts: AppliedAccount[];
	links: AppliedLink[];
	pairCodes: AppliedPairCode[];
	writes: string[];
	warnings: string[];
	channelsCache?: ChannelAccount[];
	linksCache: Map<string, ChannelAgentLink[]>;
}

interface RuntimeAction {
	action: string;
	channel_ref?: string;
	link_ref?: string;
	account_id?: string;
	link_id?: string;
	detail?: string;
}

interface AppliedAccount {
	ref: string;
	account: ChannelAccount | ChannelAccountCreated;
	created: boolean;
}

interface AppliedLink {
	ref: string;
	account_ref: string;
	link: ChannelAgentLink;
	created: boolean;
	token_env: string;
	token_written: boolean;
}

interface AppliedPairCode {
	link_ref: string;
	pair_code: ChannelPairCode;
	command_env?: string;
}

export async function runtimePlanCommand(opts: RuntimeCommandOptions = {}): Promise<void> {
	const { manifest, manifestDir } = readManifest(opts.file);
	const api = new ApiClient();
	const plan = await buildPlan(api, manifest, manifestDir);
	printResult({ plan }, opts.json);
}

export async function runtimeStatusCommand(opts: RuntimeCommandOptions = {}): Promise<void> {
	const { manifest, manifestDir } = readManifest(opts.file);
	const api = new ApiClient();
	const plan = await buildPlan(api, manifest, manifestDir);
	const status = {
		manifest: plan.manifest,
		accounts: plan.accounts,
		links: plan.links,
		outputs: plan.outputs,
		warnings: plan.warnings,
	};
	printResult({ status }, opts.json);
}

export async function runtimeApplyCommand(opts: RuntimeApplyOptions = {}): Promise<void> {
	if (opts.rotateMissingTokens && opts.rotateAllTokens) {
		throw new Error("Pass only one of --rotate-missing-tokens or --rotate-all-tokens.");
	}
	if (opts.rotateAllTokens && !opts.yes) {
		throw new Error("Pass --yes with --rotate-all-tokens to confirm token rotation.");
	}
	if (opts.dryRun) {
		await runtimePlanCommand({ file: opts.file, json: opts.json });
		return;
	}
	const { manifest, manifestDir } = readManifest(opts.file);
	preflightRuntimeOutputs(manifest, manifestDir);
	const ctx: ApplyContext = {
		api: new ApiClient(),
		manifest,
		manifestDir,
		rotateMissingTokens: opts.rotateMissingTokens ?? false,
		rotateAllTokens: opts.rotateAllTokens ?? false,
		env: new Map(),
		actions: [],
		accounts: [],
		links: [],
		pairCodes: [],
		writes: [],
		warnings: [],
		linksCache: new Map(),
	};
	for (const channel of manifest.channels) {
		await applyChannel(ctx, channel);
	}
	writeDotenvOutput(ctx);
	printResult(
		{
			applied: {
				actions: ctx.actions,
				accounts: ctx.accounts,
				links: ctx.links,
				pair_codes: ctx.pairCodes,
				writes: ctx.writes,
				warnings: ctx.warnings,
			},
		},
		opts.json,
	);
}

async function buildPlan(api: ApiClient, manifest: RuntimeManifest, manifestDir: string) {
	let channels: ChannelAccount[] | null = null;
	const accountPlans = [];
	const linkPlans = [];
	const warnings: string[] = [];
	for (const channel of manifest.channels) {
		const existingAccountId = isExistingAccountSpec(channel.account) ? channel.account.id : null;
		let existingAccount: ChannelAccount | null;
		if (existingAccountId !== null) {
			existingAccount = unwrap(
				await api.GET("/v1/channels/{account_id}", {
					params: { path: { account_id: existingAccountId } },
				}),
			);
		} else {
			if (channels === null) {
				channels = unwrap(await api.GET("/v1/channels"));
			}
			existingAccount = findManifestAccount(channels, channel) ?? null;
		}
		if (existingAccount) {
			assertManifestAccountCompatible(channel, existingAccount);
		}
		accountPlans.push({
			ref: channel.ref,
			provider: channel.provider,
			account_id: existingAccount?.id ?? null,
			action: existingAccount ? "reuse_account" : "create_private_account",
		});
		if (!existingAccount) {
			for (const link of channel.links) {
				linkPlans.push({
					ref: link.ref,
					channel_ref: channel.ref,
					agent_id: link.agent_id,
					action: "create_after_account",
				});
			}
			continue;
		}
		const links = unwrap(
			await api.GET("/v1/channels/{account_id}/agent-links", {
				params: { path: { account_id: existingAccount.id } },
			}),
		);
		for (const link of channel.links) {
			const existingLink = links.find((candidate) => candidate.agent_id === link.agent_id);
			linkPlans.push({
				ref: link.ref,
				channel_ref: channel.ref,
				account_id: existingAccount.id,
				link_id: existingLink?.id ?? null,
				agent_id: link.agent_id,
				action: existingLink ? "reuse_link" : "create_link",
			});
			if (
				existingLink &&
				!hasDotenvValue(manifestDir, manifest.outputs.dotenv, link.runtime.token_env)
			) {
				warnings.push(
					`${link.ref}: existing links do not reveal agent SDK tokens; run apply --rotate-missing-tokens to materialize ${link.runtime.token_env}.`,
				);
			}
		}
	}
	return {
		manifest: { version: manifest.version, channels: manifest.channels.length },
		accounts: accountPlans,
		links: linkPlans,
		outputs: outputPaths(manifest, manifestDir),
		warnings,
	};
}

async function applyChannel(ctx: ApplyContext, channel: RuntimeChannel): Promise<void> {
	const account = await ensureAccount(ctx, channel);
	ctx.accounts.push({ ref: channel.ref, account, created: isCreatedAccount(account) });
	for (const linkManifest of channel.links) {
		await applyLink(ctx, channel, account, linkManifest);
	}
	if (channel.commands?.sync) {
		const sync = unwrap(
			await ctx.api.POST("/v1/channels/{account_id}/commands/sync", {
				params: { path: { account_id: account.id } },
				body: {
					commands: channel.commands.spec ? (channel.commands.spec as ChannelCommandSpec[]) : null,
					guild_id: channel.commands.guild_id ?? null,
				},
			}),
		);
		ctx.actions.push({
			action: "sync_commands",
			channel_ref: channel.ref,
			account_id: account.id,
			detail: `${sync.commands.length} command(s)`,
		});
	}
}

async function ensureAccount(
	ctx: ApplyContext,
	channel: RuntimeChannel,
): Promise<ChannelAccount | ChannelAccountCreated> {
	if (isExistingAccountSpec(channel.account)) {
		const accountSpec = channel.account;
		const account = unwrap(
			await ctx.api.GET("/v1/channels/{account_id}", {
				params: { path: { account_id: accountSpec.id } },
			}),
		);
		assertManifestAccountCompatible(channel, account);
		ctx.actions.push({ action: "reuse_account", channel_ref: channel.ref, account_id: account.id });
		return account;
	}
	const createSpec = createPrivateAccountSpec(channel.account);
	const channels = await listChannels(ctx);
	const existing = channels.find(
		(candidate) =>
			candidate.provider === channel.provider &&
			candidate.visibility === "private" &&
			candidate.name === createSpec.name,
	);
	if (existing) {
		ctx.actions.push({
			action: "reuse_account",
			channel_ref: channel.ref,
			account_id: existing.id,
		});
		return existing;
	}
	const created = unwrap(
		await ctx.api.POST("/v1/channels", {
			body: {
				provider: channel.provider,
				name: createSpec.name,
				agent_id: null,
				provider_token: createSpec.provider_token_env
					? readRequiredEnv(createSpec.provider_token_env, "provider_token_env")
					: null,
				config: createSpec.config ?? null,
				secrets: resolveSecrets(createSpec.secrets_env),
			},
		}),
	);
	ctx.actions.push({
		action: "create_private_account",
		channel_ref: channel.ref,
		account_id: created.id,
	});
	ctx.channelsCache = [...channels, created];
	return created;
}

async function applyLink(
	ctx: ApplyContext,
	channel: RuntimeChannel,
	account: ChannelAccount | ChannelAccountCreated,
	linkManifest: RuntimeLink,
): Promise<void> {
	const links = await listLinks(ctx, account.id);
	let link = links.find((candidate) => candidate.agent_id === linkManifest.agent_id);
	let created = false;
	if (!link) {
		link = unwrap(
			await ctx.api.POST("/v1/channels/{account_id}/agent-links", {
				params: { path: { account_id: account.id } },
				body: { agent_id: linkManifest.agent_id },
			}),
		);
		created = true;
		ctx.linksCache.set(account.id, [...links, link]);
		ctx.actions.push({
			action: "create_link",
			channel_ref: channel.ref,
			link_ref: linkManifest.ref,
			account_id: account.id,
			link_id: link.id,
		});
	} else {
		ctx.actions.push({
			action: "reuse_link",
			channel_ref: channel.ref,
			link_ref: linkManifest.ref,
			account_id: account.id,
			link_id: link.id,
		});
	}
	link = requireLink(link, linkManifest.ref);

	let token = link.agent_token ?? null;
	let tokenWritten = false;
	const runtimeOutputGated = channel.provider === "whatsapp" && !WHATSAPP_UPSTREAM_READY;
	if (
		ctx.rotateAllTokens ||
		(ctx.rotateMissingTokens &&
			!hasDotenvValue(ctx.manifestDir, ctx.manifest.outputs.dotenv, linkManifest.runtime.token_env))
	) {
		const rotatedLink = unwrap(
			await ctx.api.POST("/v1/channels/{account_id}/agent-links/{link_id}/token", {
				params: { path: { account_id: account.id, link_id: link.id } },
			}),
		);
		link = rotatedLink;
		token = link.agent_token ?? null;
		ctx.linksCache.set(
			account.id,
			(ctx.linksCache.get(account.id) ?? []).map((candidate) =>
				candidate.id === rotatedLink.id ? rotatedLink : candidate,
			),
		);
		ctx.actions.push({
			action: "rotate_link_token",
			channel_ref: channel.ref,
			link_ref: linkManifest.ref,
			account_id: account.id,
			link_id: link.id,
		});
	}

	if (token && !runtimeOutputGated) {
		addRuntimeEnv(ctx, channel.provider, account.id, linkManifest, token);
		tokenWritten = true;
	} else if (!runtimeOutputGated) {
		const existingToken = readDotenvValue(
			ctx.manifestDir,
			ctx.manifest.outputs.dotenv,
			linkManifest.runtime.token_env,
		);
		if (existingToken) {
			addRuntimeEnv(ctx, channel.provider, account.id, linkManifest, existingToken);
			tokenWritten = true;
		} else {
			ctx.warnings.push(
				`${linkManifest.ref}: agent SDK token is not available from an existing link; use --rotate-missing-tokens if ${linkManifest.runtime.token_env} must be written.`,
			);
		}
	}

	if (linkManifest.pair_code && !runtimeOutputGated) {
		const pairCode = unwrap(
			await ctx.api.POST("/v1/channels/{account_id}/pair-codes", {
				params: { path: { account_id: account.id } },
				body: {
					agent_id: null,
					agent_link_id: link.id,
					ttl_seconds: linkManifest.pair_code.ttl_seconds,
				},
			}),
		);
		ctx.pairCodes.push({
			link_ref: linkManifest.ref,
			pair_code: pairCode,
			command_env: linkManifest.pair_code.command_env,
		});
		if (linkManifest.pair_code.command_env) {
			ctx.env.set(linkManifest.pair_code.command_env, `/bot_pair ${pairCode.code}`);
		}
		ctx.actions.push({
			action: "create_pair_code",
			channel_ref: channel.ref,
			link_ref: linkManifest.ref,
			account_id: account.id,
			link_id: link.id,
		});
	}

	if (
		channel.provider === "whatsapp" &&
		WHATSAPP_UPSTREAM_READY &&
		linkManifest.whatsapp?.baileys_credentials_dir
	) {
		await writeWhatsAppCredentials(ctx, account.id, link, linkManifest);
	}

	ctx.links.push({
		ref: linkManifest.ref,
		account_ref: channel.ref,
		link,
		created,
		token_env: linkManifest.runtime.token_env,
		token_written: tokenWritten,
	});
}

async function writeWhatsAppCredentials(
	ctx: ApplyContext,
	accountId: string,
	link: ChannelAgentLink,
	linkManifest: RuntimeLink,
): Promise<void> {
	const options = linkManifest.whatsapp;
	if (!options?.baileys_credentials_dir) return;
	const credential = unwrap(
		await ctx.api.POST("/v1/channels/whatsapp/{account_id}/tenant-creds", {
			params: { path: { account_id: accountId } },
			body: {
				agent_id: null,
				agent_link_id: link.id,
				phone_user: options.phone_user ?? null,
				device: options.device,
				name: options.name ?? null,
				self_identity: null,
			},
		}),
	);
	const dir = resolvePath(ctx.manifestDir, options.baileys_credentials_dir);
	writePrivateFileAtomic(
		join(dir, "creds.json"),
		`${JSON.stringify(credential.creds, null, 2)}\n`,
		{
			dirMode: PRIVATE_DIR_MODE,
		},
	);
	writePrivateFileAtomic(
		join(dir, "auth-cert.json"),
		`${JSON.stringify(credential.auth_cert, null, 2)}\n`,
		{ dirMode: PRIVATE_DIR_MODE },
	);
	writePrivateFileAtomic(
		join(dir, "clawdi-whatsapp.json"),
		`${JSON.stringify(credential, null, 2)}\n`,
		{ dirMode: PRIVATE_DIR_MODE },
	);
	setRuntimeEnv(
		ctx,
		runtimeEnvName(linkManifest, "websocket_url", "WA_WEBSOCKET_URL"),
		credential.websocket_url,
	);
	setRuntimeEnv(
		ctx,
		runtimeEnvName(linkManifest, "media_proxy_base_url", "WHATSAPP_MEDIA_PROXY_BASE_URL"),
		credential.media_proxy_base_url,
	);
	setRuntimeEnv(ctx, runtimeEnvName(linkManifest, "auth_dir", "CLAWDI_WHATSAPP_AUTH_DIR"), dir);
	ctx.writes.push(dir);
	ctx.actions.push({
		action: "write_whatsapp_baileys_credentials",
		link_ref: linkManifest.ref,
		account_id: accountId,
		link_id: link.id,
	});
}

function addRuntimeEnv(
	ctx: ApplyContext,
	provider: ChannelProvider,
	accountId: string,
	link: RuntimeLink,
	token: string,
): void {
	const baseUrl = stripTrailingSlash(getConfig().apiUrl);
	setRuntimeEnv(ctx, link.runtime.token_env, token);
	if (provider === "telegram") {
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "api_base_url", "TELEGRAM_BOT_API_BASE_URL"),
			`${baseUrl}/v1/channels/telegram`,
		);
	}
	if (provider === "discord") {
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "api_base_url", "DISCORD_BOT_API_BASE_URL"),
			`${baseUrl}/v1/channels/discord`,
		);
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "gateway_url", "DISCORD_GATEWAY_URL"),
			`${toWebSocketUrl(baseUrl)}/v1/channels/discord/gateway`,
		);
	}
	if (provider === "whatsapp") {
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "api_base_url", "WHATSAPP_GRAPH_API_BASE_URL"),
			`${baseUrl}/v1/channels/whatsapp/graph`,
		);
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "websocket_url", "WA_WEBSOCKET_URL"),
			`${toWebSocketUrl(baseUrl)}/v1/channels/whatsapp/${accountId}/baileys`,
		);
	}
	if (provider === "imessage") {
		setRuntimeEnv(ctx, runtimeEnvName(link, "password", "BLUEBUBBLES_PASSWORD"), token);
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "api_base_url", "BLUEBUBBLES_API_BASE_URL"),
			`${baseUrl}/v1/channels/imessage/bluebubbles/v1`,
		);
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "websocket_url", "BLUEBUBBLES_SERVER_URL"),
			`${baseUrl}/v1/channels/imessage/bluebubbles`,
		);
	}
}

function runtimeEnvName(
	link: RuntimeLink,
	key: z.infer<typeof runtimeEnvKeySchema>,
	fallback: string,
): string {
	return link.runtime.env?.[key] ?? fallback;
}

function setRuntimeEnv(ctx: ApplyContext, name: string, value: string): void {
	const existing = ctx.env.get(name);
	if (existing !== undefined && existing !== value) {
		throw new Error(
			`Runtime output ${name} has conflicting values. Use runtime.env to give each channel-specific value a distinct env name.`,
		);
	}
	ctx.env.set(name, value);
}

function writeDotenvOutput(ctx: ApplyContext): void {
	if (ctx.env.size === 0) return;
	const path = resolvePath(ctx.manifestDir, ctx.manifest.outputs.dotenv);
	const generatedLines = [...ctx.env.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${quoteDotenv(value)}`);
	const block = [DOTENV_BLOCK_START, ...generatedLines, DOTENV_BLOCK_END].join("\n");
	writePrivateFileAtomic(path, mergeDotenvManagedBlock(path, block));
	ctx.writes.push(path);
}

function readManifest(file = "clawdi.runtime.yaml"): {
	manifest: RuntimeManifest;
	manifestDir: string;
} {
	const path = resolve(file);
	const raw = readFileSync(path, "utf-8");
	const parsed = parseYaml(raw);
	const result = manifestSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`Invalid runtime manifest ${path}: ${z.prettifyError(result.error)}`);
	}
	return { manifest: result.data, manifestDir: dirname(path) };
}

function preflightRuntimeOutputs(manifest: RuntimeManifest, manifestDir: string): void {
	const baseUrl = stripTrailingSlash(getConfig().apiUrl);
	const outputs = new Map<string, { value: string; ref: string }>();
	const claim = (name: string, value: string, ref: string) => {
		const existing = outputs.get(name);
		if (existing && existing.value !== value) {
			throw new Error(
				`Runtime output ${name} has conflicting values before apply (${existing.ref}, ${ref}). Use runtime.env to give each channel-specific value a distinct env name.`,
			);
		}
		outputs.set(name, { value, ref });
	};

	for (const channel of manifest.channels) {
		const accountKey = runtimeAccountKey(channel);
		for (const link of channel.links) {
			if (channel.provider === "whatsapp" && !WHATSAPP_UPSTREAM_READY) continue;
			claim(link.runtime.token_env, `token:${link.ref}`, link.ref);
			if (link.pair_code?.command_env) {
				claim(link.pair_code.command_env, `pair-code:${link.ref}`, link.ref);
			}
			if (channel.provider === "telegram") {
				claim(
					runtimeEnvName(link, "api_base_url", "TELEGRAM_BOT_API_BASE_URL"),
					`${baseUrl}/v1/channels/telegram`,
					link.ref,
				);
			}
			if (channel.provider === "discord") {
				claim(
					runtimeEnvName(link, "api_base_url", "DISCORD_BOT_API_BASE_URL"),
					`${baseUrl}/v1/channels/discord`,
					link.ref,
				);
				claim(
					runtimeEnvName(link, "gateway_url", "DISCORD_GATEWAY_URL"),
					`${toWebSocketUrl(baseUrl)}/v1/channels/discord/gateway`,
					link.ref,
				);
			}
			if (channel.provider === "whatsapp") {
				claim(
					runtimeEnvName(link, "api_base_url", "WHATSAPP_GRAPH_API_BASE_URL"),
					`${baseUrl}/v1/channels/whatsapp/graph`,
					link.ref,
				);
				claim(
					runtimeEnvName(link, "websocket_url", "WA_WEBSOCKET_URL"),
					`whatsapp-websocket:${accountKey}`,
					link.ref,
				);
				if (link.whatsapp?.baileys_credentials_dir) {
					claim(
						runtimeEnvName(link, "media_proxy_base_url", "WHATSAPP_MEDIA_PROXY_BASE_URL"),
						`${baseUrl}/v1/channels/whatsapp/media`,
						link.ref,
					);
					claim(
						runtimeEnvName(link, "auth_dir", "CLAWDI_WHATSAPP_AUTH_DIR"),
						resolvePath(manifestDir, link.whatsapp.baileys_credentials_dir),
						link.ref,
					);
				}
			}
			if (channel.provider === "imessage") {
				claim(
					runtimeEnvName(link, "password", "BLUEBUBBLES_PASSWORD"),
					`imessage-password:${link.ref}`,
					link.ref,
				);
				claim(
					runtimeEnvName(link, "api_base_url", "BLUEBUBBLES_API_BASE_URL"),
					`${baseUrl}/v1/channels/imessage/bluebubbles/v1`,
					link.ref,
				);
				claim(
					runtimeEnvName(link, "websocket_url", "BLUEBUBBLES_SERVER_URL"),
					`${baseUrl}/v1/channels/imessage/bluebubbles`,
					link.ref,
				);
			}
		}
	}
}

function runtimeAccountKey(channel: RuntimeChannel): string {
	if (isExistingAccountSpec(channel.account)) return `account:${channel.account.id}`;
	const account = createPrivateAccountSpec(channel.account);
	return `private:${channel.provider}:${account.name}`;
}

function assertManifestAccountCompatible(channel: RuntimeChannel, account: ChannelAccount): void {
	if (account.provider !== channel.provider) {
		throw new Error(
			`${channel.ref}: account ${account.id} is provider ${account.provider}, expected ${channel.provider}.`,
		);
	}
	if (
		isExistingAccountSpec(channel.account) &&
		channel.account.visibility &&
		account.visibility !== channel.account.visibility
	) {
		throw new Error(
			`${channel.ref}: account ${account.id} visibility is ${account.visibility}, expected ${channel.account.visibility}.`,
		);
	}
}

function findManifestAccount(
	channels: ChannelAccount[],
	channel: RuntimeChannel,
): ChannelAccount | undefined {
	if (isExistingAccountSpec(channel.account)) {
		const accountSpec = channel.account;
		return channels.find((candidate) => candidate.id === accountSpec.id);
	}
	const createSpec = createPrivateAccountSpec(channel.account);
	return channels.find(
		(candidate) =>
			candidate.provider === channel.provider &&
			candidate.visibility === "private" &&
			candidate.name === createSpec.name,
	);
}

function resolveSecrets(
	secretsEnv: Record<string, string> | undefined,
): Record<string, string> | null {
	if (!secretsEnv || Object.keys(secretsEnv).length === 0) return null;
	const secrets: Record<string, string> = {};
	for (const [name, envName] of Object.entries(secretsEnv)) {
		secrets[name] = readRequiredEnv(envName, `secrets_env.${name}`);
	}
	return secrets;
}

function readRequiredEnv(envName: string, label: string): string {
	const value = process.env[envName];
	if (value === undefined || value === "") {
		throw new Error(`${label} requires ${envName} to be set.`);
	}
	return value;
}

function hasDotenvValue(manifestDir: string, output: string, envName: string): boolean {
	return readDotenvValue(manifestDir, output, envName) !== null;
}

function readDotenvValue(manifestDir: string, output: string, envName: string): string | null {
	const path = resolvePath(manifestDir, output);
	if (!existsSync(path)) return null;
	const pattern = new RegExp(`^${escapeRegExp(envName)}=(.*)$`, "m");
	const match = pattern.exec(readFileSync(path, "utf-8"));
	if (!match) return null;
	return unquoteDotenv(match[1] ?? "");
}

function mergeDotenvManagedBlock(path: string, block: string): string {
	const nextBlock = `${block}\n`;
	if (!existsSync(path)) return nextBlock;
	const current = readFileSync(path, "utf-8");
	const start = current.indexOf(DOTENV_BLOCK_START);
	const end = current.indexOf(DOTENV_BLOCK_END);
	if (start >= 0 && end >= start) {
		const afterEnd = end + DOTENV_BLOCK_END.length;
		const prefix = current.slice(0, start).replace(/\n*$/, "");
		const suffix = current.slice(afterEnd).replace(/^\n*/, "");
		return `${[prefix, nextBlock.trimEnd(), suffix].filter(Boolean).join("\n\n")}\n`;
	}
	const prefix = current.replace(/\n*$/, "");
	return prefix ? `${prefix}\n\n${nextBlock}` : nextBlock;
}

function outputPaths(manifest: RuntimeManifest, manifestDir: string): Record<string, string> {
	return { dotenv: resolvePath(manifestDir, manifest.outputs.dotenv) };
}

function resolvePath(baseDir: string, path: string): string {
	return isAbsolute(path) ? path : join(baseDir, path);
}

function quoteDotenv(value: string): string {
	if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

function unquoteDotenv(raw: string): string {
	const value = raw.trim();
	if (!value.startsWith('"')) return value;
	try {
		const parsed = JSON.parse(value);
		return typeof parsed === "string" ? parsed : value;
	} catch {
		return value;
	}
}

function toWebSocketUrl(baseUrl: string): string {
	if (baseUrl.startsWith("https://")) return `wss://${baseUrl.slice("https://".length)}`;
	if (baseUrl.startsWith("http://")) return `ws://${baseUrl.slice("http://".length)}`;
	return baseUrl;
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCreatedAccount(
	account: ChannelAccount | ChannelAccountCreated,
): account is ChannelAccountCreated {
	return "webhook_secret" in account;
}

function isExistingAccountSpec(
	account: RuntimeChannel["account"],
): account is Extract<RuntimeChannel["account"], { id: string }> {
	return "id" in account;
}

function createPrivateAccountSpec(
	account: RuntimeChannel["account"],
): Extract<RuntimeChannel["account"], { private: { name: string } }>["private"] {
	if ("private" in account) return account.private;
	throw new Error("Expected private account manifest branch.");
}

function requireLink(link: ChannelAgentLink | undefined, ref: string): ChannelAgentLink {
	if (link) return link;
	throw new Error(`${ref}: expected backend to return a bot-agent link.`);
}

function printResult(value: unknown, json = false): void {
	if (json) {
		console.log(JSON.stringify(value, null, 2));
		return;
	}
	printHumanResult(value);
	const warnings = collectWarnings(value);
	for (const warning of warnings) {
		console.error(chalk.yellow(`warning: ${warning}`));
	}
}

async function listChannels(ctx: ApplyContext): Promise<ChannelAccount[]> {
	if (!ctx.channelsCache) {
		ctx.channelsCache = unwrap(await ctx.api.GET("/v1/channels"));
	}
	return ctx.channelsCache;
}

async function listLinks(ctx: ApplyContext, accountId: string): Promise<ChannelAgentLink[]> {
	const cached = ctx.linksCache.get(accountId);
	if (cached) return cached;
	const links = unwrap(
		await ctx.api.GET("/v1/channels/{account_id}/agent-links", {
			params: { path: { account_id: accountId } },
		}),
	);
	ctx.linksCache.set(accountId, links);
	return links;
}

function printHumanResult(value: unknown): void {
	if (!value || typeof value !== "object") {
		console.log(JSON.stringify(value, null, 2));
		return;
	}
	const root = value as {
		plan?: {
			accounts?: RuntimeAction[];
			links?: RuntimeAction[];
			outputs?: Record<string, string>;
		};
		status?: {
			accounts?: RuntimeAction[];
			links?: RuntimeAction[];
			outputs?: Record<string, string>;
		};
		applied?: {
			actions?: RuntimeAction[];
			pair_codes?: AppliedPairCode[];
			writes?: string[];
		};
	};
	if (root.plan) {
		console.log(chalk.bold("Runtime plan"));
		printActions([...(root.plan.accounts ?? []), ...(root.plan.links ?? [])]);
		printOutputs(root.plan.outputs);
		return;
	}
	if (root.status) {
		console.log(chalk.bold("Runtime status"));
		printActions([...(root.status.accounts ?? []), ...(root.status.links ?? [])]);
		printOutputs(root.status.outputs);
		return;
	}
	if (root.applied) {
		console.log(`${chalk.green("✓")} Applied runtime manifest.`);
		printActions(root.applied.actions ?? []);
		if (root.applied.pair_codes?.length) {
			console.log(chalk.bold("Pair codes"));
			for (const item of root.applied.pair_codes) {
				const command = `/bot_pair ${item.pair_code.code}`;
				console.log(`  ${item.link_ref}: ${command} (expires ${item.pair_code.expires_at})`);
			}
		}
		if (root.applied.writes?.length) {
			console.log(chalk.bold("Writes"));
			for (const path of root.applied.writes) console.log(`  ${path}`);
		}
		return;
	}
	console.log(JSON.stringify(value, null, 2));
}

function printActions(actions: RuntimeAction[]): void {
	if (actions.length === 0) {
		console.log("  No changes.");
		return;
	}
	for (const action of actions) {
		const subject = action.link_ref ?? action.channel_ref ?? action.account_id ?? "-";
		const ids = [action.account_id, action.link_id].filter(Boolean).join(" ");
		const suffix = ids ? ` ${chalk.gray(ids)}` : "";
		console.log(`  ${action.action}: ${subject}${suffix}`);
	}
}

function printOutputs(outputs: Record<string, string> | undefined): void {
	if (!outputs || Object.keys(outputs).length === 0) return;
	console.log(chalk.bold("Outputs"));
	for (const [name, path] of Object.entries(outputs)) console.log(`  ${name}: ${path}`);
}

function collectWarnings(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	const root = value as {
		plan?: { warnings?: string[] };
		status?: { warnings?: string[] };
		applied?: { warnings?: string[] };
	};
	return root.plan?.warnings ?? root.status?.warnings ?? root.applied?.warnings ?? [];
}

interface RuntimeInitOptions {
	nonInteractive?: boolean;
	json?: boolean;
	manifestFile?: string;
}

interface RuntimeWatchOptions {
	intervalMs?: number | string;
	selfHealMs?: number | string;
	once?: boolean;
	json?: boolean;
}

interface RuntimeVerifyOptions {
	json?: boolean;
}

interface RuntimeDoctorCheck {
	name: string;
	ok: boolean;
	detail?: string;
	hint?: string;
}

interface MinimumCliVersionGate {
	minimumCliVersion: string;
	currentCliVersion: string;
	rejectedGeneration: number;
	activeGeneration: number | null;
	error: string;
}

type RuntimeApplyResult = RuntimeApplyConvergedResult | RuntimeApplyGatedResult;

interface RuntimeApplyConvergedResult {
	kind: "converged";
	convergence: ReturnType<typeof convergeRuntimeManifest>;
	cliUpdate: RuntimeCliUpdateResult;
}

interface RuntimeApplyGatedResult {
	kind: "minimum_cli_version_gated";
	cliUpdate: RuntimeCliUpdateResult;
	gate: MinimumCliVersionGate;
}

interface RuntimeApplyOptions {
	continueOnCliUpdateError?: boolean;
	deferCliInstall?: boolean;
	deferCliInstallReason?: string;
	manifestIdentity?: RuntimeManifestIdentity;
}

interface RuntimeManifestIdentity {
	generation?: number | null;
	etag?: string | null;
	previouslyApplied?: boolean;
}

function hasRuntimeCredential(input: {
	manifestPath?: string;
	paths?: ReturnType<typeof getRuntimePaths>;
}): boolean {
	if (input.manifestPath) return true;
	const paths = input.paths ?? getRuntimePaths();
	if (existsSync(paths.manifestLastGood)) return true;
	return ensureRuntimeAuthTokenFile(paths) !== null;
}

function runtimeCredentialName(paths: ReturnType<typeof getRuntimePaths>): string {
	return runtimeAuthTokenFileLabel(paths);
}

function writable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

function readable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function readRuntimeManifestEtag(paths: ReturnType<typeof getRuntimePaths>): string | undefined {
	if (!existsSync(paths.manifestEtag)) return undefined;
	const etag = readFileSync(paths.manifestEtag, "utf-8").trim();
	return etag || undefined;
}

function writeRuntimeManifestEtag(
	paths: ReturnType<typeof getRuntimePaths>,
	etag: string | undefined,
): void {
	if (!etag) {
		rmSync(paths.manifestEtag, { force: true });
		return;
	}
	writePrivateFileAtomic(paths.manifestEtag, `${etag}\n`, { mode: 0o644, dirMode: 0o755 });
}

function cacheRuntimeSourceManifest(load: RuntimeManifestLoad, paths: RuntimePaths): string | null {
	return cacheRuntimeLastGoodManifest(
		load.sourceManifest ?? load.manifest,
		paths,
		load.secretValues,
	);
}

function readRuntimeChannelsEtag(paths: ReturnType<typeof getRuntimePaths>): string | undefined {
	if (!existsSync(paths.channelsEtag)) return undefined;
	const etag = readFileSync(paths.channelsEtag, "utf-8").trim();
	return etag || undefined;
}

function writeRuntimeChannelsEtag(
	paths: ReturnType<typeof getRuntimePaths>,
	etag: string | undefined,
): void {
	if (!etag) {
		rmSync(paths.channelsEtag, { force: true });
		return;
	}
	writePrivateFileAtomic(paths.channelsEtag, `${etag}\n`, { mode: 0o644, dirMode: 0o755 });
}

function parsePositiveMs(
	value: number | string | undefined,
	fallback: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer number of milliseconds`);
	}
	return parsed;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readFileIfExists(path: string): string | null {
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf-8");
}

interface SystemdUnitSnapshot {
	system: Map<string, string>;
	user: Map<string, string>;
}

const RUNTIME_WATCH_SYSTEM_UNIT = "clawdi-runtime-watch.service";

function readSystemdUnitSnapshot(paths: ReturnType<typeof getRuntimePaths>): SystemdUnitSnapshot {
	return {
		system: readManagedSystemdUnits(paths.systemdSystemRoot),
		user: readManagedSystemdUnits(paths.systemdUserRoot),
	};
}

function readManagedSystemdUnits(root: string): Map<string, string> {
	const units = new Map<string, string>();
	if (!existsSync(root)) return units;
	for (const entry of readdirSync(root)) {
		if (entry.endsWith(".service")) {
			const path = join(root, entry);
			const contents = readFileIfExists(path);
			if (
				contents === null ||
				(!entry.startsWith("clawdi-") && !isGeneratedRuntimeSystemdFile(contents))
			) {
				continue;
			}
			units.set(entry, contents);
			continue;
		}
		if (!entry.endsWith(".service.d")) {
			continue;
		}
		const unitName = entry.slice(0, -".d".length);
		const dropInPath = join(root, entry, "10-clawdi-hosted.conf");
		const dropIn = readFileIfExists(dropInPath);
		if (!dropIn || !isGeneratedRuntimeSystemdFile(dropIn)) continue;
		const base = readFileIfExists(join(root, unitName)) ?? "";
		units.set(unitName, `${base}\n${dropIn}`);
	}
	return units;
}

function changedSystemdUnits(
	before: Map<string, string>,
	after: Map<string, string>,
): { changed: string[]; removed: string[]; present: string[] } {
	const changed: string[] = [];
	const removed: string[] = [];
	for (const [name, contents] of after) {
		if (before.get(name) !== contents) changed.push(name);
	}
	for (const name of before.keys()) {
		if (!after.has(name)) removed.push(name);
	}
	return {
		changed: changed.sort(),
		removed: removed.sort(),
		present: [...after.keys()].sort(),
	};
}

function applySystemdRuntimeUpdate(
	paths: ReturnType<typeof getRuntimePaths>,
	before: SystemdUnitSnapshot,
	after: SystemdUnitSnapshot,
): { applied: boolean; systemUnitsChanged: string[]; userUnitsChanged: string[] } {
	const system = changedSystemdUnits(before.system, after.system);
	const user = changedSystemdUnits(before.user, after.user);
	if (
		system.changed.length === 0 &&
		system.removed.length === 0 &&
		user.changed.length === 0 &&
		user.removed.length === 0
	) {
		return { applied: true, systemUnitsChanged: [], userUnitsChanged: [] };
	}
	if (!shouldApplySystemdRuntimeUpdate(paths)) {
		// Unit files changed on disk but this environment does not own a live
		// systemd (non-root/dev); report the divergence instead of hiding it.
		return { applied: false, systemUnitsChanged: system.changed, userUnitsChanged: user.changed };
	}

	const removableSystemUnits = system.removed.filter((unit) => unit !== RUNTIME_WATCH_SYSTEM_UNIT);
	if (removableSystemUnits.length > 0) {
		systemctl(["stop", ...removableSystemUnits], { allowNonZero: true });
	}
	systemctl(["daemon-reload"]);
	if (system.present.length > 0) systemctl(["start", ...system.present]);
	const restartSystemUnits = system.changed.filter((unit) => unit !== RUNTIME_WATCH_SYSTEM_UNIT);
	if (restartSystemUnits.length > 0) {
		systemctl(["restart", ...restartSystemUnits]);
	}

	if (user.removed.length > 0) {
		runtimeUserSystemctl(paths, ["stop", ...user.removed], {
			allowNonZero: true,
		});
	}
	runtimeUserSystemctl(paths, ["daemon-reload"]);
	if (user.present.length > 0) runtimeUserSystemctl(paths, ["enable", "--now", ...user.present]);
	if (user.removed.length > 0) {
		runtimeUserSystemctl(paths, ["disable", ...user.removed], { allowNonZero: true });
	}
	if (user.changed.length > 0) runtimeUserSystemctl(paths, ["restart", ...user.changed]);
	return { applied: true, systemUnitsChanged: system.changed, userUnitsChanged: user.changed };
}

function shouldApplySystemdRuntimeUpdate(paths: ReturnType<typeof getRuntimePaths>): boolean {
	const override = process.env.CLAWDI_SYSTEMD_APPLY?.trim().toLowerCase();
	if (override === "1" || override === "true") return true;
	if (override === "0" || override === "false") return false;
	return paths.systemdSystemRoot === "/run/systemd/system";
}

function systemctl(args: string[], opts: { allowNonZero?: boolean } = {}): string {
	return runCommand(systemctlPath(), args, opts);
}

function systemctlPath(): string {
	return process.env.CLAWDI_SYSTEMCTL_PATH?.trim() || "systemctl";
}

function runtimeUserSystemctl(
	paths: ReturnType<typeof getRuntimePaths>,
	args: string[],
	opts: { allowNonZero?: boolean } = {},
): string {
	const runtimeUser = runtimeUserName();
	if (process.getuid?.() === 0 && runtimeUser !== "root") {
		const uid = commandOutput("id", ["-u", runtimeUser]).trim();
		return runCommand(
			"gosu",
			[
				runtimeUser,
				"env",
				...runtimeUserSystemdEnvArgs(paths, runtimeUser, uid),
				"systemctl",
				"--user",
				...args,
			],
			opts,
		);
	}
	return runCommand(systemctlPath(), ["--user", ...args], opts);
}

function commandOutput(command: string, args: string[]): string {
	return runCommand(command, args);
}

function runCommand(
	command: string,
	args: string[],
	opts: { allowNonZero?: boolean } = {},
): string {
	const result = spawnSync(command, args, { encoding: "utf8" });
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	if (result.status === 0 || opts.allowNonZero) return output;
	throw new Error(
		`${command} ${args.join(" ")} failed${result.status === null ? "" : ` (${result.status})`}${
			result.error ? `: ${result.error.message}` : ""
		}${output ? `: ${output.slice(0, 1000)}` : ""}`,
	);
}

function emitRuntimeWatchEvent(value: unknown, json: boolean | undefined): void {
	if (json) {
		console.log(JSON.stringify(value));
		return;
	}
	if (!value || typeof value !== "object") return;
	const event = value as {
		status?: string;
		generation?: number;
		error?: string;
		errors?: string[];
	};
	if (event.status === "applied") {
		console.log(`runtime watch applied generation ${event.generation ?? "unknown"}`);
		return;
	}
	if (event.status === "error") {
		console.error(`runtime watch error: ${event.error ?? event.errors?.[0] ?? "unknown error"}`);
	}
}

function repairStatus(
	input: {
		bootId: string;
		stage: RuntimeBootStage;
		runtimeMode: "local" | "hosted";
		errors: string[];
		exitCode: number;
	},
	paths = getRuntimePaths(),
) {
	const policy = readHostPolicy(paths.hostPolicy);
	return buildRuntimeBootStatus(
		{
			mode: "repair",
			status: "error",
			stage: input.stage,
			bootId: input.bootId,
			runtimeMode: input.runtimeMode,
			activeGeneration: null,
			enabledRuntimes: [],
			error: input.errors[0],
			errors: input.errors,
			exitCode: input.exitCode,
			datasource: "RuntimeSource",
			hostPolicy: hostPolicySummary(policy),
		},
		paths,
	);
}

export async function runtimeVerify(opts: RuntimeVerifyOptions = {}) {
	const paths = getRuntimePaths();
	const manifestCacheExists = existsSync(paths.manifestLastGood);
	const errors: string[] = [];
	if (manifestCacheExists) {
		try {
			const raw = JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")) as unknown;
			const parsed = runtimeDesiredStateSchema.safeParse(raw);
			if (!parsed.success) {
				errors.push(`cached manifest parse failed: ${z.prettifyError(parsed.error)}`);
			}
		} catch (error) {
			errors.push(
				`cached manifest parse failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const result = {
		schemaVersion: "clawdi.runtimeVerify.v1",
		status: errors.length === 0 ? "ok" : "error",
		cliVersion: getCliVersion(),
		manifestCache: {
			path: paths.manifestLastGood,
			exists: manifestCacheExists,
			valid: errors.length === 0,
		},
		errors,
	};
	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(result, null, 2));
	} else if (errors.length === 0) {
		console.log(chalk.green("runtime verify ok"));
	} else {
		console.log(chalk.red(errors[0]));
	}
	if (errors.length > 0) process.exitCode = 1;
}

export async function runtimeInit(opts: RuntimeInitOptions = {}) {
	const paths = getRuntimePaths();
	const mode = detectRuntimeMode();
	const bootId = randomUUID();

	if (mode !== "hosted") {
		const status = repairStatus(
			{
				bootId,
				runtimeMode: mode,
				stage: "detect",
				exitCode: 2,
				errors: [
					"runtime init requires hosted runtime mode (host policy or CLAWDI_RUNTIME_MODE=hosted)",
				],
			},
			paths,
		);
		if (opts.json || !process.stdout.isTTY) {
			console.log(JSON.stringify(status, null, 2));
		} else {
			console.log(chalk.red("runtime init is only available in hosted runtime mode."));
		}
		process.exitCode = 2;
		return;
	}

	const hostPolicy = readHostPolicy(paths.hostPolicy);
	try {
		ensureRuntimeStateDirs(paths);
	} catch (e) {
		const status = repairStatus(
			{
				bootId,
				runtimeMode: mode,
				stage: "detect",
				exitCode: 20,
				errors: [
					`could not create runtime state directories: ${
						e instanceof Error ? e.message : String(e)
					}`,
				],
			},
			paths,
		);
		if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify(status, null, 2));
		else console.log(chalk.red(status.error));
		process.exitCode = 20;
		return;
	}

	const credentialAvailable = hasRuntimeCredential({ manifestPath: opts.manifestFile, paths });
	const nonInteractiveOk = opts.nonInteractive === true;
	const errors: string[] = [];
	let stage: RuntimeBootStage = "detect";
	let exitCode = 20;
	if (!nonInteractiveOk) {
		errors.push("runtime init requires --non-interactive in hosted mode");
	}
	if (!hostPolicy.exists) {
		errors.push(`missing hosted runtime policy at ${hostPolicy.path}`);
	} else if (!hostPolicy.valid) {
		errors.push(
			`invalid hosted runtime policy at ${hostPolicy.path}: ${hostPolicy.error ?? "parse failed"}`,
		);
	}
	if (!credentialAvailable) {
		errors.push(`missing ${runtimeCredentialName(paths)} and no last-good runtime manifest cache`);
	}
	if (errors.length === 0) {
		stage = "local";
		const loaded = await loadRuntimeManifest(paths, { manifestPath: opts.manifestFile });
		if ("errors" in loaded) {
			stage = loaded.stage;
			exitCode = loaded.mode === "manifest-rejected" ? 22 : 21;
			errors.push(...loaded.errors);
			const status = buildRuntimeBootStatus(
				{
					mode: loaded.mode,
					status: "error",
					stage,
					bootId,
					runtimeMode: mode,
					activeGeneration: loaded.activeGeneration ?? null,
					rejectedGeneration: loaded.rejectedGeneration ?? null,
					enabledRuntimes: [],
					error: errors[0],
					errors,
					exitCode,
					datasource: "RuntimeSource",
					hostPolicy: hostPolicySummary(hostPolicy),
				},
				paths,
			);
			writeRuntimeBootStatus(status, paths);

			if (opts.json || !process.stdout.isTTY) {
				console.log(JSON.stringify(status, null, 2));
			} else {
				console.log(chalk.bold("clawdi runtime init"));
				console.log(chalk.yellow(`  ${loaded.mode}: ${errors[0]}`));
				console.log(chalk.gray(`  status: ${paths.bootStatus}`));
			}
			process.exitCode = exitCode;
			return;
		}

		let channelsLoad: RuntimeChannelsLoad | null = null;
		let convergenceLoad = loaded;
		if (loaded.source === "remote-datasource") {
			const loadedChannels = await loadRemoteRuntimeChannels(paths);
			if ("errors" in loadedChannels) {
				const status = buildRuntimeBootStatus(
					{
						mode: loadedChannels.mode,
						status: "error",
						stage: loadedChannels.stage,
						bootId,
						runtimeMode: mode,
						activeGeneration: null,
						enabledRuntimes: [],
						error: loadedChannels.errors[0],
						errors: loadedChannels.errors,
						exitCode: 21,
						datasource: "RuntimeSource",
						hostPolicy: hostPolicySummary(hostPolicy),
					},
					paths,
				);
				writeRuntimeBootStatus(status, paths);

				if (opts.json || !process.stdout.isTTY) {
					console.log(JSON.stringify(status, null, 2));
				} else {
					console.log(chalk.bold("clawdi runtime init"));
					console.log(chalk.yellow(`  ${loadedChannels.mode}: ${loadedChannels.errors[0]}`));
					console.log(chalk.gray(`  status: ${paths.bootStatus}`));
				}
				process.exitCode = 21;
				return;
			}
			if ("notModified" in loadedChannels) {
				const errors = ["runtime channels datasource returned 304 without If-None-Match"];
				const status = buildRuntimeBootStatus(
					{
						mode: "repair",
						status: "error",
						stage: "network",
						bootId,
						runtimeMode: mode,
						activeGeneration: null,
						enabledRuntimes: [],
						error: errors[0],
						errors,
						exitCode: 21,
						datasource: "RuntimeSource",
						hostPolicy: hostPolicySummary(hostPolicy),
					},
					paths,
				);
				writeRuntimeBootStatus(status, paths);

				if (opts.json || !process.stdout.isTTY) {
					console.log(JSON.stringify(status, null, 2));
				} else {
					console.log(chalk.bold("clawdi runtime init"));
					console.log(chalk.yellow(`  repair: ${errors[0]}`));
					console.log(chalk.gray(`  status: ${paths.bootStatus}`));
				}
				process.exitCode = 21;
				return;
			}
			channelsLoad = loadedChannels;
			convergenceLoad = applyRuntimeChannelsToManifestLoad(loaded, channelsLoad);
		}

		let applyResult: RuntimeApplyResult;
		const previousSystemdUnits = readSystemdUnitSnapshot(paths);
		try {
			applyResult = withRuntimeConvergeLock(paths, () =>
				applyRuntimeDesiredState(convergenceLoad, paths, {
					manifestIdentity: {
						generation: convergenceLoad.manifest.generation,
						etag: loaded.etag ?? null,
					},
				}),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = buildRuntimeBootStatus(
				{
					mode: "repair",
					status: "error",
					stage: "final",
					bootId,
					runtimeMode: mode,
					activeGeneration: convergenceLoad.manifest.generation,
					instanceId: convergenceLoad.manifest.instanceId,
					enabledRuntimes: [],
					error: message,
					errors: [message],
					exitCode: 23,
					datasource: "RuntimeSource",
					hostPolicy: hostPolicySummary(hostPolicy),
					manifestSource: {
						type: convergenceLoad.source,
						path: convergenceLoad.sourcePath,
						offline: convergenceLoad.offline,
					},
				},
				paths,
			);
			writeRuntimeBootStatus(status, paths);
			if (opts.json || !process.stdout.isTTY) {
				console.log(JSON.stringify(status, null, 2));
			} else {
				console.log(chalk.bold("clawdi runtime init"));
				console.log(chalk.red(`  repair: ${message}`));
				console.log(chalk.gray(`  status: ${paths.bootStatus}`));
			}
			process.exitCode = 23;
			return;
		}
		if (applyResult.kind === "minimum_cli_version_gated") {
			const status = buildRuntimeBootStatus(
				{
					mode: "repair",
					status: "error",
					stage: "config",
					bootId,
					runtimeMode: mode,
					activeGeneration: applyResult.gate.activeGeneration,
					rejectedGeneration: applyResult.gate.rejectedGeneration,
					instanceId: convergenceLoad.manifest.instanceId,
					enabledRuntimes: [],
					error: applyResult.gate.error,
					errors: [applyResult.gate.error],
					exitCode: 24,
					datasource: "RuntimeSource",
					hostPolicy: hostPolicySummary(hostPolicy),
					manifestSource: {
						type: convergenceLoad.source,
						path: convergenceLoad.sourcePath,
						offline: convergenceLoad.offline,
					},
				},
				paths,
			);
			writeRuntimeBootStatus(status, paths);
			if (opts.json || !process.stdout.isTTY) {
				console.log(
					JSON.stringify(
						{ ...status, cliUpdate: applyResult.cliUpdate, gate: applyResult.gate },
						null,
						2,
					),
				);
			} else {
				console.log(chalk.bold("clawdi runtime init"));
				console.log(chalk.yellow(`  repair: ${applyResult.gate.error}`));
				console.log(chalk.gray(`  status: ${paths.bootStatus}`));
			}
			process.exitCode = 24;
			return;
		}
		const { convergence } = applyResult;
		let systemdApplyError: string | null = null;
		// Convergence errors must not block systemd apply: unit files already
		// changed on disk, and stops/disables for removed units have to land
		// even when an unrelated runtime install or projection failed.
		try {
			applySystemdRuntimeUpdate(paths, previousSystemdUnits, readSystemdUnitSnapshot(paths));
		} catch (error) {
			systemdApplyError = `systemd apply failed: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
		const runtimeErrors = [
			...convergence.installErrors,
			...(systemdApplyError ? [systemdApplyError] : []),
		];
		const installOk = runtimeErrors.length === 0;
		if (installOk && loaded.source === "remote-datasource") {
			convergence.outputs.manifestLastGood = cacheRuntimeSourceManifest(convergenceLoad, paths);
			writeRuntimeManifestEtag(paths, loaded.etag);
			if (channelsLoad) {
				writeRuntimeChannelsEtag(paths, channelsLoad.etag);
			}
		} else if (installOk) {
			convergence.outputs.manifestLastGood = cacheRuntimeSourceManifest(convergenceLoad, paths);
		}
		const status = buildRuntimeBootStatus(
			{
				mode: convergence.mode,
				status: installOk ? "ok" : "error",
				stage: "final",
				bootId,
				runtimeMode: mode,
				activeGeneration: convergence.manifest.generation,
				instanceId: convergence.manifest.instanceId,
				enabledRuntimes: convergence.enabledRuntimes,
				error: runtimeErrors[0],
				errors: runtimeErrors,
				exitCode: installOk ? 0 : 23,
				datasource: "RuntimeSource",
				hostPolicy: hostPolicySummary(hostPolicy),
				manifestSource: {
					type: convergence.source,
					path: convergence.sourcePath,
					offline: convergence.offline,
				},
				convergence: convergence.outputs,
			},
			paths,
		);
		writeRuntimeBootStatus(status, paths);

		if (opts.json || !process.stdout.isTTY) {
			console.log(JSON.stringify(status, null, 2));
		} else {
			console.log(chalk.bold("clawdi runtime init"));
			console.log(
				chalk.green(`  ${convergence.mode}: generation ${convergence.manifest.generation}`),
			);
			console.log(chalk.gray(`  status: ${paths.bootStatus}`));
		}
		process.exitCode = installOk ? 0 : 23;
		return;
	}

	const status = buildRuntimeBootStatus(
		{
			mode: "repair",
			status: "error",
			stage,
			bootId,
			runtimeMode: mode,
			activeGeneration: null,
			enabledRuntimes: [],
			error: errors[0],
			errors,
			exitCode,
			datasource: "RuntimeSource",
			hostPolicy: hostPolicySummary(hostPolicy),
		},
		paths,
	);
	writeRuntimeBootStatus(status, paths);

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(status, null, 2));
	} else {
		console.log(chalk.bold("clawdi runtime init"));
		console.log(chalk.yellow(`  repair: ${errors[0]}`));
		console.log(chalk.gray(`  status: ${paths.bootStatus}`));
	}
	process.exitCode = exitCode;
}

async function runtimeWatchTick(
	paths: ReturnType<typeof getRuntimePaths>,
	opts: { forceRefresh: boolean; deferCliInstall?: boolean; deferCliInstallReason?: string },
): Promise<Record<string, unknown>> {
	const manifestEtag = opts.forceRefresh ? undefined : readRuntimeManifestEtag(paths);
	const channelsEtag = opts.forceRefresh ? undefined : readRuntimeChannelsEtag(paths);
	const [manifestLoad, channelsLoad] = await Promise.all([
		loadRemoteRuntimeManifest(paths, { ifNoneMatch: manifestEtag }),
		loadRemoteRuntimeChannels(paths, { ifNoneMatch: channelsEtag }),
	]);
	if ("errors" in manifestLoad) {
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			mode: manifestLoad.mode,
			stage: manifestLoad.stage,
			errors: manifestLoad.errors,
			error: manifestLoad.errors[0],
			activeGeneration: manifestLoad.activeGeneration ?? null,
			rejectedGeneration: manifestLoad.rejectedGeneration ?? null,
		};
	}
	if ("errors" in channelsLoad) {
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			mode: channelsLoad.mode,
			stage: channelsLoad.stage,
			errors: channelsLoad.errors,
			error: channelsLoad.errors[0],
		};
	}
	if ("notModified" in manifestLoad && "notModified" in channelsLoad) {
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "not_modified",
			sourcePath: manifestLoad.sourcePath,
			etag: manifestLoad.etag ?? manifestEtag ?? null,
			channelsSourcePath: channelsLoad.sourcePath,
			channelsEtag: channelsLoad.etag ?? channelsEtag ?? null,
		};
	}

	try {
		const previousSystemdUnits = readSystemdUnitSnapshot(paths);
		const loaded = await runtimeWatchLoadForApply(paths, manifestLoad, channelsLoad);
		const manifestIdentity = runtimeManifestIdentityForWatch(
			manifestLoad,
			manifestEtag,
			loaded.manifest.generation,
			paths,
		);
		const applyResult = withRuntimeConvergeLock(paths, () =>
			applyRuntimeDesiredState(loaded, paths, {
				continueOnCliUpdateError: true,
				deferCliInstall: opts.deferCliInstall,
				deferCliInstallReason: opts.deferCliInstallReason,
				manifestIdentity,
			}),
		);
		if (applyResult.kind === "minimum_cli_version_gated") {
			const cliUpdateError =
				applyResult.cliUpdate.status === "error"
					? (applyResult.cliUpdate.error ?? "CLI update failed")
					: null;
			const errors = [...(cliUpdateError ? [cliUpdateError] : []), applyResult.gate.error];
			return {
				schemaVersion: "clawdi.runtimeWatchEvent.v1",
				status: "error",
				stage: cliUpdateError ? "cli-update" : "config",
				mode: "minimum_cli_version_gated",
				errors,
				error: errors[0],
				activeGeneration: applyResult.gate.activeGeneration,
				rejectedGeneration: applyResult.gate.rejectedGeneration,
				cliUpdate: applyResult.cliUpdate,
				selfReexec: shouldSelfReexecForCliUpdate(applyResult.cliUpdate),
				gate: applyResult.gate,
			};
		}
		const { convergence, cliUpdate } = applyResult;
		const cliUpdateError =
			cliUpdate.status === "error" ? (cliUpdate.error ?? "CLI update failed") : null;
		let systemdApplyResult = {
			applied: false,
			systemUnitsChanged: [] as string[],
			userUnitsChanged: [] as string[],
		};
		let systemdApplyError: string | null = null;
		// Convergence errors must not block systemd apply: unit files already
		// changed on disk, and stops/disables for removed units have to land
		// even when an unrelated runtime install or projection failed.
		try {
			systemdApplyResult = applySystemdRuntimeUpdate(
				paths,
				previousSystemdUnits,
				readSystemdUnitSnapshot(paths),
			);
		} catch (error) {
			systemdApplyError = `systemd apply failed: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
		const errors = [
			...(cliUpdateError ? [cliUpdateError] : []),
			...convergence.installErrors,
			...(systemdApplyError ? [systemdApplyError] : []),
		];
		let selfReexec = shouldSelfReexecForCliUpdate(cliUpdate);
		const systemdUnitsChanged =
			systemdApplyResult.systemUnitsChanged.length > 0 ||
			systemdApplyResult.userUnitsChanged.length > 0;
		if (errors.length > 0) {
			if (convergence.installErrors.length === 0 && !systemdApplyError) {
				convergence.outputs.manifestLastGood = cacheRuntimeSourceManifest(loaded, paths);
				if (!("notModified" in manifestLoad)) {
					writeRuntimeManifestEtag(paths, manifestLoad.etag);
				}
				if (!("notModified" in channelsLoad)) {
					writeRuntimeChannelsEtag(paths, channelsLoad.etag);
				}
			}
			const cliRollback = maybeRollbackFailedCliUpgrade(paths, manifestIdentity, errors);
			if (cliRollback.status === "rolled_back") selfReexec = false;
			return {
				schemaVersion: "clawdi.runtimeWatchEvent.v1",
				status: "error",
				stage: cliUpdateError ? "cli-update" : "final",
				errors,
				error: errors[0],
				activeGeneration: convergence.manifest.generation,
				cliUpdate,
				cliRollback,
				selfReexec,
				systemdUnitsChanged,
				systemdApply: systemdApplyResult,
				convergence: convergence.outputs,
			};
		}
		convergence.outputs.manifestLastGood = cacheRuntimeSourceManifest(loaded, paths);
		if (!("notModified" in manifestLoad)) {
			writeRuntimeManifestEtag(paths, manifestLoad.etag);
		}
		if (!("notModified" in channelsLoad)) {
			writeRuntimeChannelsEtag(paths, channelsLoad.etag);
		}
		completePendingRuntimeCliUpgrade(paths, getCliVersion(), manifestIdentity);
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "applied",
			sourcePath: loaded.sourcePath,
			etag:
				"notModified" in manifestLoad
					? (manifestLoad.etag ?? manifestEtag ?? null)
					: (manifestLoad.etag ?? null),
			channelsSourcePath: channelsLoad.sourcePath,
			channelsEtag:
				"notModified" in channelsLoad
					? (channelsLoad.etag ?? channelsEtag ?? null)
					: (channelsLoad.etag ?? null),
			generation: convergence.manifest.generation,
			instanceId: convergence.manifest.instanceId,
			enabledRuntimes: convergence.enabledRuntimes,
			cliUpdate,
			selfReexec,
			systemdUnitsChanged,
			systemdApply: systemdApplyResult,
			convergence: convergence.outputs,
		};
	} catch (error) {
		return {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			stage: "final",
			errors: [error instanceof Error ? error.message : String(error)],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function applyRuntimeDesiredState(
	load: RuntimeManifestLoad,
	paths: ReturnType<typeof getRuntimePaths>,
	opts: RuntimeApplyOptions = {},
): RuntimeApplyResult {
	let cliUpdate: RuntimeCliUpdateResult;
	try {
		cliUpdate = applyRuntimeCliDesiredState(load.manifest, paths, {
			deferInstall: opts.deferCliInstall,
			deferReason: opts.deferCliInstallReason,
			manifestIdentity: opts.manifestIdentity,
		});
	} catch (error) {
		if (!opts.continueOnCliUpdateError) throw error;
		cliUpdate = runtimeCliUpdateError(load.manifest, paths, error);
	}
	const gate = minimumCliVersionGate(load.manifest, paths);
	if (gate) {
		return { kind: "minimum_cli_version_gated", cliUpdate, gate };
	}
	const convergence = convergeRuntimeManifest(load, paths, { cacheLastGood: false });
	return { kind: "converged", cliUpdate, convergence };
}

function minimumCliVersionGate(
	manifest: RuntimeManifestLoad["manifest"],
	paths: RuntimePaths,
): MinimumCliVersionGate | null {
	const minimumCliVersion = manifest.minimumCliVersion?.trim();
	if (!minimumCliVersion) return null;
	const currentCliVersion = getCliVersion();
	if (!isSemverLessThan(currentCliVersion, minimumCliVersion)) return null;
	return {
		minimumCliVersion,
		currentCliVersion,
		rejectedGeneration: manifest.generation,
		activeGeneration: readLastGoodManifestGeneration(paths),
		error: `runtime desired state requires clawdi CLI >= ${minimumCliVersion}; current CLI is ${currentCliVersion}. Keeping last-good applied state while CLI self-upgrade runs.`,
	};
}

function readLastGoodManifestGeneration(paths: RuntimePaths): number | null {
	try {
		const parsed = JSON.parse(readFileSync(paths.manifestLastGood, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const generation = (parsed as Record<string, unknown>).generation;
		return typeof generation === "number" && Number.isInteger(generation) ? generation : null;
	} catch {
		return null;
	}
}

function runtimeCliUpdateError(
	manifest: RuntimeManifestLoad["manifest"],
	paths: ReturnType<typeof getRuntimePaths>,
	error: unknown,
): RuntimeCliUpdateResult {
	const rawRegistry = (manifest.clawdiCli as Record<string, unknown> | undefined)?.registry;
	return {
		status: "error",
		packageSpec: manifest.clawdiCli?.packageSpec?.trim() || null,
		registry: typeof rawRegistry === "string" && rawRegistry.trim() ? rawRegistry.trim() : null,
		npmPrefix: paths.cliNpmPrefix,
		npmCache: paths.cliNpmCache,
		activePath: paths.cliManagedBin,
		activeTarget: null,
		version: null,
		error: error instanceof Error ? error.message : String(error),
	};
}

function shouldSelfReexecForCliUpdate(cliUpdate: RuntimeCliUpdateResult): boolean {
	if (cliUpdate.status === "installed") return true;
	if (!cliUpdate.version || !cliUpdate.activeTarget) return false;
	return cliUpdate.version !== getCliVersion();
}

function runtimeManifestIdentityForWatch(
	manifestLoad: RuntimeManifestLoad | RuntimeManifestNotModified,
	existingEtag: string | undefined,
	generation: number,
	paths: RuntimePaths,
): RuntimeManifestIdentity {
	const etag =
		"notModified" in manifestLoad
			? (manifestLoad.etag ?? existingEtag ?? null)
			: (manifestLoad.etag ?? null);
	const lastGoodGeneration = readLastGoodManifestGeneration(paths);
	return {
		generation,
		etag,
		previouslyApplied:
			(existingEtag !== undefined && etag === existingEtag) ||
			(existingEtag === undefined && lastGoodGeneration === generation),
	};
}

function maybeRollbackFailedCliUpgrade(
	paths: RuntimePaths,
	manifestIdentity: RuntimeManifestIdentity,
	errors: string[],
): RuntimeCliRollbackResult {
	const rollback = rollbackPendingRuntimeCliUpgrade(
		paths,
		`first converge after CLI upgrade failed: ${errors[0] ?? "unknown error"}`,
		manifestIdentity,
	);
	if (rollback.status === "rolled_back") {
		errors.push(
			`rolled back clawdi CLI ${rollback.version} to previous version ${rollback.previousVersion ?? "unknown"}`,
		);
	} else if (rollback.status === "error") {
		errors.push(`failed to roll back clawdi CLI ${rollback.version}: ${rollback.error}`);
	}
	return rollback;
}

async function runtimeWatchLoadForApply(
	paths: ReturnType<typeof getRuntimePaths>,
	manifestLoad: RuntimeManifestLoad | RuntimeManifestNotModified,
	channelsLoad: RuntimeChannelsLoad | RuntimeChannelsNotModified,
): Promise<RuntimeManifestLoad> {
	const loaded =
		"notModified" in manifestLoad ? await loadFullRuntimeManifestForWatch(paths) : manifestLoad;
	const channelDesired =
		"notModified" in channelsLoad ? await loadFullRuntimeChannelsForWatch(paths) : channelsLoad;
	return applyRuntimeChannelsToManifestLoad(loaded, channelDesired);
}

async function loadFullRuntimeManifestForWatch(
	paths: ReturnType<typeof getRuntimePaths>,
): Promise<RuntimeManifestLoad> {
	const loaded = await loadRemoteRuntimeManifest(paths);
	if ("notModified" in loaded) {
		throw new Error("runtime manifest datasource returned 304 without If-None-Match");
	}
	if ("errors" in loaded) {
		throw new Error(loaded.errors.join("; "));
	}
	return loaded;
}

async function loadFullRuntimeChannelsForWatch(
	paths: ReturnType<typeof getRuntimePaths>,
): Promise<RuntimeChannelsLoad> {
	const loaded = await loadRemoteRuntimeChannels(paths);
	if ("notModified" in loaded) {
		throw new Error("runtime channels datasource returned 304 without If-None-Match");
	}
	if ("errors" in loaded) {
		throw new Error(loaded.errors.join("; "));
	}
	return loaded;
}

export async function runtimeWatch(opts: RuntimeWatchOptions = {}) {
	const paths = getRuntimePaths();
	const mode = detectRuntimeMode();
	const intervalMs = parsePositiveMs(opts.intervalMs, 15_000, "--interval-ms");
	const selfHealMs = parsePositiveMs(opts.selfHealMs, 300_000, "--self-heal-ms");
	let lastFullFetchAt = Date.now();
	let cliInstallRetryPending = false;
	let cliInstallBackoffMs = 0;
	let nextCliInstallRetryAt = 0;

	if (mode !== "hosted") {
		const event = {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			stage: "detect",
			error: "runtime watch requires hosted runtime mode",
			errors: ["runtime watch requires hosted runtime mode"],
		};
		emitRuntimeWatchEvent(event, opts.json);
		process.exitCode = 2;
		return;
	}

	try {
		ensureRuntimeStateDirs(paths);
	} catch (error) {
		const message = `could not create runtime state directories: ${
			error instanceof Error ? error.message : String(error)
		}`;
		const event = {
			schemaVersion: "clawdi.runtimeWatchEvent.v1",
			status: "error",
			stage: "detect",
			error: message,
			errors: [message],
		};
		emitRuntimeWatchEvent(event, opts.json);
		process.exitCode = 20;
		return;
	}

	for (;;) {
		const now = Date.now();
		const cliInstallRetryDue = cliInstallRetryPending && now >= nextCliInstallRetryAt;
		const deferCliInstall = cliInstallRetryPending && !cliInstallRetryDue;
		const forceRefresh = now - lastFullFetchAt >= selfHealMs || cliInstallRetryDue;
		const event = await runtimeWatchTick(paths, {
			forceRefresh,
			deferCliInstall,
			deferCliInstallReason: deferCliInstall
				? `CLI install retry is in backoff until ${new Date(nextCliInstallRetryAt).toISOString()}`
				: undefined,
		});
		const cliUpdateStatus = runtimeWatchCliUpdateStatus(event);
		if (cliUpdateStatus === "error") {
			cliInstallRetryPending = true;
			cliInstallBackoffMs = nextCliInstallBackoffMs(cliInstallBackoffMs);
			nextCliInstallRetryAt = Date.now() + cliInstallBackoffMs;
		} else if (
			cliUpdateStatus === "installed" ||
			cliUpdateStatus === "current" ||
			cliUpdateStatus === "not_requested"
		) {
			cliInstallRetryPending = false;
			cliInstallBackoffMs = 0;
			nextCliInstallRetryAt = 0;
		}
		if (event.status === "applied" || forceRefresh) lastFullFetchAt = Date.now();
		writeRuntimeWatchStatus(event, paths);
		emitRuntimeWatchEvent(event, opts.json);
		if (opts.once) {
			if (event.status === "error") process.exitCode = 1;
			else process.exitCode = 0;
			return;
		}
		if (event.selfReexec === true) {
			return;
		}
		await sleep(intervalMs);
	}
}

function runtimeWatchCliUpdateStatus(
	event: Record<string, unknown>,
): RuntimeCliUpdateResult["status"] | null {
	const cliUpdate = event.cliUpdate;
	if (!cliUpdate || typeof cliUpdate !== "object" || Array.isArray(cliUpdate)) return null;
	const status = (cliUpdate as Record<string, unknown>).status;
	if (
		status === "not_requested" ||
		status === "current" ||
		status === "installed" ||
		status === "deferred" ||
		status === "error"
	) {
		return status;
	}
	return null;
}

function nextCliInstallBackoffMs(previousMs: number): number {
	if (previousMs <= 0) return 60_000;
	return Math.min(previousMs * 2, 300_000);
}

export async function runtimeSidecar(): Promise<void> {
	if (detectRuntimeMode() !== "hosted") {
		throw new Error("runtime sidecar is only available in hosted runtime mode");
	}
	const shouldStartBridge = Boolean(process.env[RUNTIME_BRIDGE_SURFACES_ENV]?.trim());
	const shouldStartEgress = Boolean(process.env.CLAWDI_EGRESS_ENV_FILE?.trim());
	if (!shouldStartBridge && !shouldStartEgress) {
		throw new Error("runtime sidecar requires at least one configured module.");
	}

	let bridge: Awaited<ReturnType<typeof startRuntimeBridge>> | null = null;
	let egress: RuntimeEgressModule | null = null;
	try {
		if (shouldStartEgress) {
			egress = await startRuntimeEgress();
			console.error(`runtime sidecar egress module listening on 127.0.0.1:${egress.port}`);
		}
		if (shouldStartBridge) {
			bridge = await startRuntimeBridge();
			console.error(
				`runtime sidecar bridge module listening on ${bridge.surfaces
					.map(
						(surface) =>
							`${surface.listenHost}:${surface.listenPort}->${surface.upstreamHost}:${surface.upstreamPort}`,
					)
					.join(", ")}`,
			);
		}
		notifySystemdReady("runtime sidecar ready");
	} catch (error) {
		egress?.close();
		await bridge?.close();
		throw error;
	}

	const shutdown = waitForShutdownSignal().then(() => ({ kind: "shutdown" as const }));
	const egressExit = egress?.wait().then(() => ({ kind: "egress-exit" as const }));
	try {
		await (egressExit ? Promise.race([shutdown, egressExit]) : shutdown);
	} finally {
		egress?.close();
		await bridge?.close();
		await egressExit?.catch(() => undefined);
	}
}

interface RuntimeEgressModule {
	port: number;
	close: () => void;
	wait: () => Promise<void>;
}

async function startRuntimeEgress(): Promise<RuntimeEgressModule> {
	const config = loadTransparentEgressEnvConfig(process.env);
	const mitmdump = startMitmdump(config);
	const mitmdumpExit = waitForChildExit(mitmdump);
	let redirectApplied = false;
	let closeRequested = false;
	const cleanup = () => {
		if (!redirectApplied) return;
		try {
			cleanupTransparentEgressNftRulesFromEnv(process.env);
		} catch (error) {
			console.error(
				`transparent egress nft cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		redirectApplied = false;
	};
	const close = () => {
		closeRequested = true;
		cleanup();
		if (!mitmdump.killed) mitmdump.kill("SIGTERM");
	};
	try {
		await waitForTcpPort("127.0.0.1", config.transparentPort, 15_000, () =>
			childHasExited(mitmdump),
		);
		await waitForFile(config.caCertPath, 10_000, () => childHasExited(mitmdump));
		publishEgressSystemCaBundle(config);
		applyTransparentEgressNftRulesFromEnv(process.env);
		redirectApplied = true;
		return {
			port: config.transparentPort,
			close,
			wait: async () => {
				const exit = await mitmdumpExit;
				cleanup();
				if (!closeRequested) {
					const reason = exit.signal === null ? `status ${exit.code}` : `signal ${exit.signal}`;
					throw new Error(`egress engine exited unexpectedly with ${reason}`);
				}
			},
		};
	} catch (error) {
		close();
		throw error;
	}
}

function startMitmdump(config: TransparentEgressEnvConfig): ChildProcess {
	if (!existsSync(config.engineBinaryPath)) {
		throw new Error(`egress engine binary is missing: ${config.engineBinaryPath}`);
	}
	if (!existsSync(config.addonPath)) {
		throw new Error(`egress addon is missing: ${config.addonPath}`);
	}
	const mitmdumpArgs = [
		"--mode",
		"transparent",
		"--listen-host",
		"127.0.0.1",
		"--listen-port",
		String(config.transparentPort),
		"--set",
		`confdir=${config.caDir}`,
		"--set",
		"stream_large_bodies=1",
		"--set",
		"termlog_verbosity=info",
		"-s",
		config.addonPath,
	];
	const childEnv = buildEgressEngineEnv(process.env, {
		envFile: config.envFile,
		home: config.caDir,
	});
	const command = config.engineBinaryPath;
	const args = mitmdumpArgs;
	const child = runningAsRootCommand()
		? spawnWithNumericIdentity(config.egressUid, config.egressGid, command, args, childEnv)
		: spawnWithCurrentEgressIdentity(config.egressUid, config.egressGid, command, args, childEnv);
	child.stdout?.pipe(process.stdout);
	child.stderr?.pipe(process.stderr);
	return child;
}

export function buildEgressEngineSpawnCommand(
	commandExists: (command: string) => boolean,
	uid: number,
	gid: number,
	command: string,
	args: string[],
): { command: string; args: string[] } {
	if (uid === 0 || gid === 0) throw new Error("egress engine identity must be non-root");
	if (commandExists("setpriv")) {
		return {
			command: "setpriv",
			args: [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "--", command, ...args],
		};
	}
	if (commandExists("gosu")) {
		return { command: "gosu", args: [`${uid}:${gid}`, command, ...args] };
	}
	throw new Error(`cannot drop egress engine to ${uid}:${gid}; install setpriv or gosu`);
}

export function assertCurrentEgressIdentity(
	currentUid: number | undefined,
	currentGid: number | undefined,
	configuredUid: number,
	configuredGid: number,
): void {
	if (currentUid === undefined || currentGid === undefined) {
		throw new Error("cannot verify non-root egress engine UID/GID on this platform");
	}
	if (currentUid === 0 || currentGid === 0) {
		throw new Error("egress engine identity must be non-root");
	}
	if (currentUid !== configuredUid || currentGid !== configuredGid) {
		throw new Error(
			`current egress engine identity ${currentUid}:${currentGid} does not match configured ${configuredUid}:${configuredGid}`,
		);
	}
}

function spawnWithCurrentEgressIdentity(
	uid: number,
	gid: number,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): ChildProcess {
	assertCurrentEgressIdentity(process.getuid?.(), process.getgid?.(), uid, gid);
	return spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
}

function spawnWithNumericIdentity(
	uid: number,
	gid: number,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): ChildProcess {
	const child = buildEgressEngineSpawnCommand(commandExistsOnPath, uid, gid, command, args);
	return spawn(child.command, child.args, {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function waitForChildExit(
	child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function childHasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitForTcpPort(
	host: string,
	port: number,
	timeoutMs: number,
	hasExited: () => boolean,
): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const attempt = () => {
			if (hasExited()) {
				reject(new Error(`egress engine exited before listening on ${host}:${port}`));
				return;
			}
			if (tcpPortIsListening(host, port)) {
				resolve();
				return;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				reject(new Error(`timed out waiting for egress engine on ${host}:${port}`));
				return;
			}
			setTimeout(attempt, 100);
		};
		attempt();
	});
}

function tcpPortIsListening(host: string, port: number): boolean {
	const portHex = port.toString(16).toUpperCase().padStart(4, "0");
	const allowedHosts =
		host === "127.0.0.1" ? new Set(["0100007F"]) : new Set(["00000000", "0100007F"]);
	try {
		for (const raw of readFileSync("/proc/net/tcp", "utf-8").split(/\r?\n/).slice(1)) {
			const fields = raw.trim().split(/\s+/);
			const localAddress = fields[1] ?? "";
			const state = fields[3] ?? "";
			const [address, localPort] = localAddress.split(":");
			if (state === "0A" && localPort === portHex && address && allowedHosts.has(address)) {
				return true;
			}
		}
	} catch {
		return false;
	}
	return false;
}

function waitForFile(path: string, timeoutMs: number, hasExited: () => boolean): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const attempt = () => {
			if (hasExited()) {
				reject(new Error(`egress engine exited before writing ${path}`));
				return;
			}
			if (existsSync(path)) {
				resolve();
				return;
			}
			if (Date.now() - startedAt >= timeoutMs) {
				reject(new Error(`timed out waiting for ${path}`));
				return;
			}
			setTimeout(attempt, 100);
		};
		attempt();
	});
}

function publishEgressSystemCaBundle(config: TransparentEgressEnvConfig): void {
	if (config.systemCaBundle === SYSTEM_CA_BUNDLE) {
		throw new Error("CLAWDI_EGRESS_SYSTEM_CA_BUNDLE must be a runtime-managed CA projection path");
	}
	const systemCa = readFileSync(SYSTEM_CA_BUNDLE, "utf-8");
	const egressCa = readFileSync(config.caCertPath, "utf-8");
	mkdirSync(dirname(config.systemCaBundle), { recursive: true });
	writeFileSync(config.systemCaBundle, `${systemCa.trimEnd()}\n${egressCa.trimEnd()}\n`, {
		mode: 0o644,
	});
	chmodSync(config.systemCaBundle, 0o644);
}

function runningAsRootCommand(): boolean {
	return typeof process.getuid === "function" && process.getuid() === 0;
}

function commandExistsOnPath(command: string): boolean {
	const result = spawnSync("command", ["-v", command], {
		shell: true,
		stdio: "ignore",
	});
	return result.status === 0;
}

function waitForShutdownSignal(): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			process.off("SIGTERM", done);
			process.off("SIGINT", done);
			resolve();
		};
		process.once("SIGTERM", done);
		process.once("SIGINT", done);
	});
}

function notifySystemdReady(status: string): void {
	if (!process.env.NOTIFY_SOCKET) return;
	spawnSync("systemd-notify", ["--ready", `--status=${status}`], {
		stdio: "ignore",
		env: process.env,
	});
}

export async function runtimeStatus(opts: { json?: boolean } = {}) {
	const paths = getRuntimePaths();
	const read = readRuntimeBootStatus(paths);
	const payload = {
		schemaVersion: "clawdi.runtimeStatus.v1",
		runtimeMode: paths.mode,
		paths: {
			bootStatus: paths.bootStatus,
			cloudStatus: paths.cloudStatus,
			cloudResult: paths.cloudResult,
			installInventory: paths.installInventory,
			syncState: paths.syncState,
			instanceData: paths.instanceData,
		},
		...read,
	};

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(chalk.bold("clawdi runtime status"));
	console.log();
	if (!read.exists) {
		console.log(chalk.gray("  No runtime boot status has been written yet."));
		return;
	}
	if (read.error) {
		console.log(chalk.red(`  Could not read ${read.source}: ${read.error}`));
		process.exitCode = 1;
		return;
	}
	if (!read.status) {
		console.log(chalk.yellow("  Runtime status files exist, but boot-status.json is missing."));
		return;
	}
	console.log(`  Mode: ${read.status?.mode ?? "unknown"}`);
	console.log(`  Status: ${read.status?.status ?? "unknown"}`);
	console.log(`  Stage: ${read.status?.stage ?? "unknown"}`);
	console.log(chalk.gray(`  Source: ${read.source}`));
	if (read.status?.error) console.log(chalk.yellow(`  Error: ${read.status.error}`));
}

export async function runtimeDoctor(opts: { json?: boolean } = {}) {
	const paths = getRuntimePaths();
	const policy = readHostPolicy(paths.hostPolicy);
	const lastStatus = readRuntimeBootStatus(paths);
	const checks: RuntimeDoctorCheck[] = [
		{
			name: "Runtime mode",
			ok: paths.mode === "hosted",
			detail: paths.mode,
			hint: "Hosted mode requires a host policy or CLAWDI_RUNTIME_MODE=hosted.",
		},
		{
			name: "Host policy",
			ok: policy.exists && policy.valid,
			detail: policy.exists ? (policy.valid ? policy.path : policy.error) : "missing",
			hint: "Expected a readable JSON policy at the configured host policy path.",
		},
		{
			name: "Service state",
			ok: existsSync(paths.serviceStateRoot) && writable(paths.serviceStateRoot),
			detail: paths.serviceStateRoot,
			hint: "The hosted service-state volume must be writable by the runtime user.",
		},
		{
			name: "Runtime HOME",
			ok: existsSync(paths.userHome) && writable(paths.userHome),
			detail: paths.userHome,
			hint: "HOME should be the persistent runtime/user volume.",
		},
		{
			name: "Ephemeral runtime state",
			ok: existsSync(paths.runRoot),
			detail: paths.runRoot,
			hint: "The runtime tmpfs path should be recreated on each boot and owned by the system boundary.",
		},
		{
			name: "Sensitive instance data",
			ok: !existsSync(paths.sensitiveInstanceData) || readable(paths.sensitiveInstanceData),
			detail: existsSync(paths.sensitiveInstanceData) ? "present" : "absent",
		},
		{
			name: "Last boot status",
			ok:
				!lastStatus.exists ||
				(lastStatus.status?.status === "ok" && lastStatus.status.errors.length === 0),
			detail: !lastStatus.exists
				? "none"
				: (lastStatus.error ??
					`${lastStatus.status?.status ?? "unknown"} / ${lastStatus.status?.mode ?? "unknown"}`),
			hint: "Run `clawdi runtime status` for the last boot result.",
		},
	];
	const failed = checks.filter((check) => !check.ok).length;

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(checks, null, 2));
		if (failed > 0) process.exitCode = 1;
		return;
	}

	console.log(chalk.bold("clawdi runtime doctor"));
	console.log();
	for (const check of checks) {
		const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
		const detail = check.detail ? chalk.gray(` — ${check.detail}`) : "";
		console.log(`  ${icon} ${check.name}${detail}`);
		if (!check.ok && check.hint) console.log(chalk.gray(`     ${check.hint}`));
	}
	if (failed > 0) process.exitCode = 1;
}
