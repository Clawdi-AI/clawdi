import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { components } from "@clawdi/shared/api";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ApiClient, unwrap } from "../lib/api-client";
import { getConfig } from "../lib/config";
import { PRIVATE_DIR_MODE, writePrivateFileAtomic } from "../lib/private-file";
import { getCliVersion } from "../lib/version";
import { applyRuntimeChannelsToManifestLoad } from "../runtime/channels";
import { applyRuntimeCliDesiredState, type RuntimeCliUpdateResult } from "../runtime/cli-update";
import { readHostPolicy } from "../runtime/host-policy";
import {
	convergeRuntimeManifest,
	loadRuntimeManifest,
	withRuntimeConvergeLock,
} from "../runtime/manifest";
import {
	loadRemoteRuntimeChannels,
	loadRemoteRuntimeManifest,
	type RuntimeChannelsLoad,
	type RuntimeChannelsNotModified,
	type RuntimeManifestLoad,
	type RuntimeManifestNotModified,
	runtimeSourceAuthEnv,
} from "../runtime/manifest-source";
import { detectRuntimeMode, getRuntimePaths } from "../runtime/paths";
import {
	buildRuntimeBootStatus,
	ensureRuntimeStateDirs,
	hostPolicySummary,
	type RuntimeBootStage,
	readRuntimeBootStatus,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../runtime/state";
import { startRuntimeUiBridge } from "../runtime/ui-bridge";

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
				await api.GET("/api/channels/{account_id}", {
					params: { path: { account_id: existingAccountId } },
				}),
			);
		} else {
			if (channels === null) {
				channels = unwrap(await api.GET("/api/channels"));
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
			await api.GET("/api/channels/{account_id}/agent-links", {
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
			await ctx.api.POST("/api/channels/{account_id}/commands/sync", {
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
			await ctx.api.GET("/api/channels/{account_id}", {
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
		await ctx.api.POST("/api/channels", {
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
			await ctx.api.POST("/api/channels/{account_id}/agent-links", {
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
	if (
		ctx.rotateAllTokens ||
		(ctx.rotateMissingTokens &&
			!hasDotenvValue(ctx.manifestDir, ctx.manifest.outputs.dotenv, linkManifest.runtime.token_env))
	) {
		const rotatedLink = unwrap(
			await ctx.api.POST("/api/channels/{account_id}/agent-links/{link_id}/token", {
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

	if (token) {
		addRuntimeEnv(ctx, channel.provider, account.id, linkManifest, token);
		tokenWritten = true;
	} else {
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

	if (linkManifest.pair_code) {
		const pairCode = unwrap(
			await ctx.api.POST("/api/channels/{account_id}/pair-codes", {
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

	if (channel.provider === "whatsapp" && linkManifest.whatsapp?.baileys_credentials_dir) {
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
		await ctx.api.POST("/api/channels/whatsapp/{account_id}/tenant-creds", {
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
			`${baseUrl}/api/channels/telegram`,
		);
	}
	if (provider === "discord") {
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "api_base_url", "DISCORD_BOT_API_BASE_URL"),
			`${baseUrl}/api/channels/discord`,
		);
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "gateway_url", "DISCORD_GATEWAY_URL"),
			`${toWebSocketUrl(baseUrl)}/api/channels/discord/gateway`,
		);
	}
	if (provider === "whatsapp") {
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "api_base_url", "WHATSAPP_GRAPH_API_BASE_URL"),
			`${baseUrl}/api/channels/whatsapp/graph`,
		);
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "websocket_url", "WA_WEBSOCKET_URL"),
			`${toWebSocketUrl(baseUrl)}/api/channels/whatsapp/${accountId}/baileys`,
		);
	}
	if (provider === "imessage") {
		setRuntimeEnv(ctx, runtimeEnvName(link, "password", "BLUEBUBBLES_PASSWORD"), token);
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "api_base_url", "BLUEBUBBLES_API_BASE_URL"),
			`${baseUrl}/api/channels/imessage/bluebubbles/v1`,
		);
		setRuntimeEnv(
			ctx,
			runtimeEnvName(link, "websocket_url", "BLUEBUBBLES_SERVER_URL"),
			`${baseUrl}/api/channels/imessage/bluebubbles`,
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
			claim(link.runtime.token_env, `token:${link.ref}`, link.ref);
			if (link.pair_code?.command_env) {
				claim(link.pair_code.command_env, `pair-code:${link.ref}`, link.ref);
			}
			if (channel.provider === "telegram") {
				claim(
					runtimeEnvName(link, "api_base_url", "TELEGRAM_BOT_API_BASE_URL"),
					`${baseUrl}/api/channels/telegram`,
					link.ref,
				);
			}
			if (channel.provider === "discord") {
				claim(
					runtimeEnvName(link, "api_base_url", "DISCORD_BOT_API_BASE_URL"),
					`${baseUrl}/api/channels/discord`,
					link.ref,
				);
				claim(
					runtimeEnvName(link, "gateway_url", "DISCORD_GATEWAY_URL"),
					`${toWebSocketUrl(baseUrl)}/api/channels/discord/gateway`,
					link.ref,
				);
			}
			if (channel.provider === "whatsapp") {
				claim(
					runtimeEnvName(link, "api_base_url", "WHATSAPP_GRAPH_API_BASE_URL"),
					`${baseUrl}/api/channels/whatsapp/graph`,
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
						`${baseUrl}/api/channels/whatsapp/media`,
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
					`${baseUrl}/api/channels/imessage/bluebubbles/v1`,
					link.ref,
				);
				claim(
					runtimeEnvName(link, "websocket_url", "BLUEBUBBLES_SERVER_URL"),
					`${baseUrl}/api/channels/imessage/bluebubbles`,
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
		ctx.channelsCache = unwrap(await ctx.api.GET("/api/channels"));
	}
	return ctx.channelsCache;
}

async function listLinks(ctx: ApplyContext, accountId: string): Promise<ChannelAgentLink[]> {
	const cached = ctx.linksCache.get(accountId);
	if (cached) return cached;
	const links = unwrap(
		await ctx.api.GET("/api/channels/{account_id}/agent-links", {
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

interface RuntimeDoctorCheck {
	name: string;
	ok: boolean;
	detail?: string;
	hint?: string;
}

interface RuntimeApplyResult {
	convergence: ReturnType<typeof convergeRuntimeManifest>;
	cliUpdate: RuntimeCliUpdateResult;
}

interface RuntimeApplyOptions {
	continueOnCliUpdateError?: boolean;
	deferCliInstall?: boolean;
	deferCliInstallReason?: string;
}

function hasRuntimeCredential(input: {
	manifestPath?: string;
	paths?: ReturnType<typeof getRuntimePaths>;
}): boolean {
	if (input.manifestPath) return true;
	const paths = input.paths ?? getRuntimePaths();
	if (existsSync(paths.manifestLastGood)) return true;
	try {
		if (readFileSync(join(paths.runRoot, "sync", "auth-token"), "utf-8").trim()) return true;
	} catch {
		// Fall through to the configured auth environment variable.
	}
	try {
		return Boolean(process.env[runtimeSourceAuthEnv(paths)]?.trim());
	} catch {
		return Boolean(process.env.CLAWDI_AUTH_TOKEN?.trim());
	}
}

function runtimeCredentialName(paths: ReturnType<typeof getRuntimePaths>): string {
	try {
		return runtimeSourceAuthEnv(paths);
	} catch {
		return "CLAWDI_AUTH_TOKEN";
	}
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

const RUNTIME_WATCH_PROGRAM = "clawdi-runtime-watch";

function supervisorctl(
	paths: ReturnType<typeof getRuntimePaths>,
	args: string[],
	opts: { allowNonZero?: boolean } = {},
): string {
	const command = process.env.CLAWDI_SUPERVISORCTL_PATH?.trim() || "supervisorctl";
	const result = spawnSync(command, ["-c", paths.supervisorConfig, ...args], {
		encoding: "utf8",
	});
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	if (result.status === 0 || opts.allowNonZero) return output;
	const action = args.join(" ");
	throw new Error(
		`supervisorctl ${action} failed${result.status === null ? "" : ` (${result.status})`}${
			result.error ? `: ${result.error.message}` : ""
		}${output ? `: ${output.slice(0, 1000)}` : ""}`,
	);
}

function readFileIfExists(path: string): string | null {
	if (!existsSync(path)) return null;
	return readFileSync(path, "utf-8");
}

function applySupervisorRuntimeUpdate(paths: ReturnType<typeof getRuntimePaths>): void {
	const targets = supervisorRuntimeUpdateTargets(paths);
	supervisorctl(paths, ["reread"]);
	for (const target of targets) {
		supervisorctl(paths, ["update", target]);
	}
}

function supervisorRuntimeUpdateTargets(paths: ReturnType<typeof getRuntimePaths>): string[] {
	const targets = new Set<string>();
	for (const program of supervisorStatusPrograms(paths)) {
		targets.add(program);
	}
	for (const program of supervisorConfigPrograms(paths)) {
		targets.add(program);
	}
	targets.delete(RUNTIME_WATCH_PROGRAM);
	return [...targets].sort();
}

function supervisorStatusPrograms(paths: ReturnType<typeof getRuntimePaths>): string[] {
	const output = supervisorctl(paths, ["status"], { allowNonZero: true });
	return output
		.split(/\r?\n/)
		.map((line) => line.trim().match(/^([A-Za-z0-9_.-]+)\s+/)?.[1])
		.filter((program): program is string => Boolean(program));
}

function supervisorConfigPrograms(paths: ReturnType<typeof getRuntimePaths>): string[] {
	try {
		const config = readFileSync(paths.supervisorConfig, "utf-8");
		return [...config.matchAll(/^\[program:([^\]]+)\]$/gm)].map((match) => match[1]);
	} catch {
		return [];
	}
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
		try {
			applyResult = withRuntimeConvergeLock(paths, () =>
				applyRuntimeDesiredState(convergenceLoad, paths),
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
		const { convergence } = applyResult;
		const installOk = convergence.installErrors.length === 0;
		if (installOk && loaded.source === "remote-datasource") {
			writeRuntimeManifestEtag(paths, loaded.etag);
			if (channelsLoad) {
				writeRuntimeChannelsEtag(paths, channelsLoad.etag);
			}
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
				error: convergence.installErrors[0],
				errors: convergence.installErrors,
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
		const previousSupervisorConfig = readFileIfExists(paths.supervisorConfig);
		const loaded = await runtimeWatchLoadForApply(paths, manifestLoad, channelsLoad);
		const { convergence, cliUpdate } = withRuntimeConvergeLock(paths, () =>
			applyRuntimeDesiredState(loaded, paths, {
				continueOnCliUpdateError: true,
				deferCliInstall: opts.deferCliInstall,
				deferCliInstallReason: opts.deferCliInstallReason,
			}),
		);
		const cliUpdateError =
			cliUpdate.status === "error" ? (cliUpdate.error ?? "CLI update failed") : null;
		const errors = [...(cliUpdateError ? [cliUpdateError] : []), ...convergence.installErrors];
		const selfReexec = shouldSelfReexecForCliUpdate(cliUpdate);
		const supervisorConfigChanged =
			readFileIfExists(paths.supervisorConfig) !== previousSupervisorConfig;
		if (convergence.installErrors.length === 0 && supervisorConfigChanged) {
			applySupervisorRuntimeUpdate(paths);
		}
		if (errors.length > 0) {
			if (convergence.installErrors.length === 0 && !("notModified" in manifestLoad)) {
				writeRuntimeManifestEtag(paths, manifestLoad.etag);
			}
			if (convergence.installErrors.length === 0 && !("notModified" in channelsLoad)) {
				writeRuntimeChannelsEtag(paths, channelsLoad.etag);
			}
			return {
				schemaVersion: "clawdi.runtimeWatchEvent.v1",
				status: "error",
				stage: cliUpdateError ? "cli-update" : "final",
				errors,
				error: errors[0],
				activeGeneration: convergence.manifest.generation,
				cliUpdate,
				selfReexec,
				supervisorConfigChanged,
				convergence: convergence.outputs,
			};
		}
		if (!("notModified" in manifestLoad)) {
			writeRuntimeManifestEtag(paths, manifestLoad.etag);
		}
		if (!("notModified" in channelsLoad)) {
			writeRuntimeChannelsEtag(paths, channelsLoad.etag);
		}
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
			supervisorConfigChanged,
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
		});
	} catch (error) {
		if (!opts.continueOnCliUpdateError) throw error;
		cliUpdate = runtimeCliUpdateError(load.manifest, paths, error);
	}
	const convergence = convergeRuntimeManifest(load, paths);
	return { cliUpdate, convergence };
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

export async function runtimeUiBridge(): Promise<void> {
	if (detectRuntimeMode() !== "hosted") {
		throw new Error("runtime ui-bridge is only available in hosted runtime mode");
	}
	const bridge = await startRuntimeUiBridge();
	console.error(
		`runtime ui bridge listening on ${bridge.targets
			.map(
				(target) =>
					`${target.listenHost}:${target.listenPort}->${target.targetHost}:${target.targetPort}`,
			)
			.join(", ")}`,
	);
	await waitForShutdownSignal();
	await bridge.close();
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
			ok: existsSync(paths.runRoot) && writable(paths.runRoot),
			detail: paths.runRoot,
			hint: "The runtime tmpfs path should be recreated on each boot.",
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
