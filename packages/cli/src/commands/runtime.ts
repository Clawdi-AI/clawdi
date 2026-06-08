import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { components } from "@clawdi/shared/api";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ApiClient, unwrap } from "../lib/api-client";
import { getConfig } from "../lib/config";
import { writePrivateFileAtomic } from "../lib/private-file";

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
	const channels = unwrap(await api.GET("/api/channels"));
	const accountPlans = [];
	const linkPlans = [];
	const warnings: string[] = [];
	for (const channel of manifest.channels) {
		const existingAccount = findManifestAccount(channels, channel);
		const existingAccountId = isExistingAccountSpec(channel.account) ? channel.account.id : null;
		const missingExistingAccount = !existingAccount && existingAccountId !== null;
		accountPlans.push({
			ref: channel.ref,
			provider: channel.provider,
			account_id: existingAccount?.id ?? null,
			action: existingAccount
				? "reuse_account"
				: missingExistingAccount
					? "resolve_account"
					: "create_private_account",
		});
		if (!existingAccount) {
			if (missingExistingAccount) {
				warnings.push(
					`${channel.ref}: account ${existingAccountId} is not visible from GET /api/channels; apply will validate it with GET /api/channels/${existingAccountId}.`,
				);
			}
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
		if (account.provider !== channel.provider) {
			throw new Error(
				`${channel.ref}: account ${account.id} is provider ${account.provider}, expected ${channel.provider}.`,
			);
		}
		if (accountSpec.visibility && account.visibility !== accountSpec.visibility) {
			throw new Error(
				`${channel.ref}: account ${account.id} visibility is ${account.visibility}, expected ${accountSpec.visibility}.`,
			);
		}
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
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writePrivateFileAtomic(join(dir, "creds.json"), `${JSON.stringify(credential.creds, null, 2)}\n`);
	writePrivateFileAtomic(
		join(dir, "auth-cert.json"),
		`${JSON.stringify(credential.auth_cert, null, 2)}\n`,
	);
	writePrivateFileAtomic(
		join(dir, "clawdi-whatsapp.json"),
		`${JSON.stringify(credential, null, 2)}\n`,
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
