import type { components } from "@clawdi/shared/api";
import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";

type ChannelAccountCreated = components["schemas"]["ChannelAccountCreatedResponse"];
type ChannelAgentLink = components["schemas"]["ChannelAgentLinkResponse"];
type ChannelPairCode = components["schemas"]["ChannelPairCodeResponse"];
type ChannelProvider = components["schemas"]["ChannelAccountCreate"]["provider"];

interface JsonOption {
	json?: boolean;
}

interface ChannelCreateOptions extends JsonOption {
	agent?: string;
	providerToken?: string;
	config?: string;
	secret?: string[];
}

interface ChannelLinkOptions extends JsonOption {
	agent: string;
}

interface ChannelPairCodeOptions extends JsonOption {
	agent?: string;
	link?: string;
	ttl?: string;
}

export async function channelListCommand(opts: JsonOption = {}): Promise<void> {
	const api = new ApiClient();
	const channels = unwrap(await api.GET("/api/channels"));
	if (opts.json) {
		console.log(JSON.stringify({ channels }, null, 2));
		return;
	}
	if (channels.length === 0) {
		console.log("No channels configured.");
		console.log(chalk.gray("Create a private bot: clawdi channel create telegram my-bot"));
		return;
	}
	printTable(
		["ID", "PROVIDER", "VISIBILITY", "STATUS", "NAME"],
		channels.map((channel) => [
			shortId(channel.id),
			channel.provider,
			channel.visibility,
			channel.status,
			channel.name,
		]),
	);
}

export async function channelCreateCommand(
	provider: string,
	name: string,
	opts: ChannelCreateOptions = {},
): Promise<void> {
	const api = new ApiClient();
	const body = {
		provider: parseProvider(provider),
		name,
		agent_id: opts.agent ?? null,
		provider_token: opts.providerToken ?? null,
		config: opts.config ? parseObjectJson(opts.config, "--config") : null,
		secrets: parseSecrets(opts.secret),
	};
	const channel = unwrap(await api.POST("/api/channels", { body }));
	if (opts.json) {
		console.log(JSON.stringify({ channel }, null, 2));
		return;
	}
	printCreatedChannel(channel);
}

export async function channelLinksCommand(accountId: string, opts: JsonOption = {}): Promise<void> {
	const api = new ApiClient();
	const links = unwrap(
		await api.GET("/api/channels/{account_id}/agent-links", {
			params: { path: { account_id: accountId } },
		}),
	);
	if (opts.json) {
		console.log(JSON.stringify({ account_id: accountId, links }, null, 2));
		return;
	}
	if (links.length === 0) {
		console.log("No agent links for this channel.");
		console.log(chalk.gray(`Create one: clawdi channel link ${accountId} --agent <agent-id>`));
		return;
	}
	printTable(
		["LINK ID", "AGENT ID", "STATUS", "CREATED"],
		links.map((link) => [shortId(link.id), shortId(link.agent_id), link.status, link.created_at]),
	);
}

export async function channelLinkCommand(
	accountId: string,
	opts: ChannelLinkOptions,
): Promise<void> {
	const api = new ApiClient();
	const link = unwrap(
		await api.POST("/api/channels/{account_id}/agent-links", {
			params: { path: { account_id: accountId } },
			body: { agent_id: opts.agent },
		}),
	);
	if (opts.json) {
		console.log(JSON.stringify({ link }, null, 2));
		return;
	}
	printAgentLink(link);
}

export async function channelPairCodeCommand(
	accountId: string,
	opts: ChannelPairCodeOptions = {},
): Promise<void> {
	if (opts.agent && opts.link) {
		console.error(chalk.red("Pass either --agent or --link, not both."));
		process.exitCode = 1;
		return;
	}
	const ttlSeconds = parseTtl(opts.ttl);
	const api = new ApiClient();
	const pairCode = unwrap(
		await api.POST("/api/channels/{account_id}/pair-codes", {
			params: { path: { account_id: accountId } },
			body: {
				agent_id: opts.agent ?? null,
				agent_link_id: opts.link ?? null,
				ttl_seconds: ttlSeconds,
			},
		}),
	);
	if (opts.json) {
		console.log(JSON.stringify({ pair_code: pairCode }, null, 2));
		return;
	}
	printPairCode(pairCode);
}

export async function channelBindingsCommand(
	accountId: string,
	opts: JsonOption = {},
): Promise<void> {
	const api = new ApiClient();
	const bindings = unwrap(
		await api.GET("/api/channels/{account_id}/bindings", {
			params: { path: { account_id: accountId } },
		}),
	);
	if (opts.json) {
		console.log(JSON.stringify({ account_id: accountId, bindings }, null, 2));
		return;
	}
	if (bindings.length === 0) {
		console.log("No paired chats for this channel.");
		return;
	}
	printTable(
		["BINDING ID", "CHAT", "TYPE", "LINK", "STATUS"],
		bindings.map((binding) => [
			shortId(binding.id),
			binding.external_chat_name ?? binding.external_chat_id,
			binding.external_chat_type ?? "-",
			binding.agent_link_id ? shortId(binding.agent_link_id) : "-",
			binding.status,
		]),
	);
}

function printCreatedChannel(channel: ChannelAccountCreated): void {
	console.log(
		`${chalk.green("✓")} Created ${channel.provider} channel ${chalk.cyan(channel.name)}.`,
	);
	console.log(`  Channel ID: ${channel.id}`);
	console.log(`  Visibility: ${channel.visibility}`);
	console.log(`  Webhook URL: ${channel.webhook_url}`);
	console.log(`  Webhook secret: ${channel.webhook_secret}`);
	if (channel.agent_link_id) {
		console.log(`  Agent link ID: ${channel.agent_link_id}`);
	}
	if (channel.agent_token) {
		console.log(`  Agent SDK token: ${channel.agent_token}`);
	}
	console.log(chalk.gray(`Generate a pair code: clawdi channel pair-code ${channel.id}`));
}

function printAgentLink(link: ChannelAgentLink): void {
	console.log(`${chalk.green("✓")} Linked channel to agent.`);
	console.log(`  Link ID: ${link.id}`);
	console.log(`  Agent ID: ${link.agent_id}`);
	if (link.agent_token) {
		console.log(`  Agent SDK token: ${link.agent_token}`);
	}
	console.log(
		chalk.gray(
			`Pair an external chat: clawdi channel pair-code ${link.account_id} --link ${link.id}`,
		),
	);
}

function printPairCode(pairCode: ChannelPairCode): void {
	console.log(`${chalk.green("✓")} Pair code created.`);
	console.log(`  Code: ${chalk.cyan(pairCode.code)}`);
	console.log(`  Agent link ID: ${pairCode.agent_link_id}`);
	console.log(`  Agent ID: ${pairCode.agent_id}`);
	if (pairCode.agent_token) {
		console.log(`  Agent SDK token: ${pairCode.agent_token}`);
	}
	console.log(`  Expires at: ${pairCode.expires_at}`);
	console.log(chalk.gray(`Send this in the external chat: /bot_pair ${pairCode.code}`));
}

function parseProvider(value: string): ChannelProvider {
	if (value === "telegram" || value === "discord" || value === "whatsapp" || value === "imessage") {
		return value;
	}
	throw new Error("provider must be one of: telegram, discord, whatsapp, imessage");
}

function parseTtl(raw: string | undefined): number {
	if (raw === undefined) return 900;
	const ttl = Number(raw);
	if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) {
		throw new Error("--ttl must be an integer number of seconds between 60 and 86400.");
	}
	return ttl;
}

function parseObjectJson(raw: string, flag: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${flag} must be valid JSON.`);
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`${flag} must be a JSON object.`);
	}
	return parsed;
}

function parseSecrets(values: string[] | undefined): Record<string, string> | null {
	if (!values || values.length === 0) return null;
	const secrets: Record<string, string> = {};
	for (const value of values) {
		const index = value.indexOf("=");
		if (index <= 0) {
			throw new Error("--secret must use NAME=value.");
		}
		const name = value.slice(0, index).trim();
		const secret = value.slice(index + 1);
		if (!name || !secret) {
			throw new Error("--secret must use NAME=value with non-empty name and value.");
		}
		secrets[name] = secret;
	}
	return secrets;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 8) : id;
}

function printTable(headers: string[], rows: string[][]): void {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
	);
	console.log(headers.map((header, index) => chalk.bold(header.padEnd(widths[index]))).join("  "));
	for (const row of rows) {
		console.log(row.map((cell, index) => cell.padEnd(widths[index])).join("  "));
	}
}
