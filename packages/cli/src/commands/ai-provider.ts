import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type AiProvider,
	type AiProviderApiMode,
	type AiProviderAuth,
	type AiProviderCapabilities,
	type AiProviderCatalog,
	type AiProviderType,
	defaultAiProviderApiMode,
	defaultAiProviderBaseUrl,
	isAiProviderApiMode,
	isAiProviderId,
	isAiProviderType,
	isProviderAuthProfileId,
	isRuntimeEnvName,
	isSupportedSecretRef,
	validateAiProviderCatalog,
} from "@clawdi/shared";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import {
	aiProviderCatalogPath,
	coerceAiProviderCatalog,
	readAiProviderCatalog,
	removeAiProvider,
	upsertAiProvider,
	writeAiProviderCatalog,
} from "../lib/ai-provider-catalog";
import {
	inspectAiProviderAuth,
	parseAiProviderTestTimeout,
	probeAiProvider,
	publicAiProviderAuthStatus,
} from "../lib/ai-provider-test";
import { ApiClient } from "../lib/api-client";
import { PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import {
	collectAgentCredentialProfilePayload,
	materializeAgentCredentialProfilePayload,
} from "./agent-credentials";

interface AiProviderAddOptions {
	type?: string;
	label?: string;
	baseUrl?: string;
	defaultModel?: string;
	apiMode?: string;
	auth?: string;
	agentEnv?: string;
	capability?: string[];
	setDefault?: boolean;
	replace?: boolean;
	json?: boolean;
}

interface AiProviderEditOptions {
	type?: string;
	label?: string;
	baseUrl?: string;
	defaultModel?: string;
	apiMode?: string;
	auth?: string;
	agentEnv?: string;
	capability?: string[];
	setDefault?: boolean;
	json?: boolean;
}

interface AiProviderListOptions {
	json?: boolean;
}

interface AiProviderRemoveOptions {
	force?: boolean;
	json?: boolean;
}

interface AiProviderValidateOptions {
	allowNoAuthPublic?: boolean;
	json?: boolean;
}

interface AiProviderExportOptions {
	out?: string;
	includeSecrets?: boolean;
	secretPassphrase?: boolean;
	secretPassphraseEnv?: string;
}

interface AiProviderImportOptions {
	fromHermes?: string;
	fromOpenclaw?: string;
	importSecrets?: string;
	out?: string;
	secretPassphraseEnv?: string;
	replace?: boolean;
	json?: boolean;
}

interface AiProviderTestOptions {
	model?: string;
	timeout?: string;
	live?: boolean;
	probe?: boolean;
	json?: boolean;
}

interface AiProviderImportAuthOptions {
	tool?: string;
	project?: string;
	profile?: string;
	source?: string;
	from?: string;
	to?: string;
	keychainService?: string;
	keychainAccount?: string;
	yes?: boolean;
	dryRun?: boolean;
	json?: boolean;
}

interface AiProviderMaterializeAuthOptions {
	project?: string;
	to?: string;
	yes?: boolean;
	dryRun?: boolean;
	json?: boolean;
	backup?: boolean;
}

interface AiProviderConnectOptions {
	method?: string;
	tool?: string;
	callback?: string;
	redirectUri?: string;
	timeout?: string;
	open?: boolean;
	yes?: boolean;
	dryRun?: boolean;
	json?: boolean;
}

interface AiProviderCompleteOAuthOptions {
	code?: string;
	state?: string;
	redirectUrl?: string;
	redirectUri?: string;
	json?: boolean;
}

interface AiProviderBackendResponse {
	provider_id: string;
	auth: AiProviderAuth;
	runtime_env_name?: string | null;
}

interface AiProviderAuthResolveBackendResponse {
	auth_type: AiProviderAuth["type"];
	payload?: string | null;
	tool?: string | null;
	profile?: string | null;
}

interface AiProviderOAuthStartBackendResponse {
	provider_id: string;
	oauth_provider: string;
	profile: string;
	auth_url: string;
	state: string;
	redirect_uri: string;
	expires_at: string;
}

interface OAuthLoopbackOptions {
	host: string;
	path: string;
	ports: number[];
}

const CODEX_OAUTH_PROVIDER = "codex";
const CODEX_AGENT_PROFILE_TOOL = "codex";
const CODEX_OAUTH_LOOPBACK: OAuthLoopbackOptions = {
	host: "localhost",
	path: "/auth/callback",
	ports: [1455, 1457],
};

export async function aiProviderListCommand(opts: AiProviderListOptions = {}): Promise<void> {
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	if (opts.json) {
		console.log(JSON.stringify(catalog, null, 2));
		return;
	}
	if (catalog.providers.length === 0) {
		console.log("No AI Providers configured.");
		return;
	}
	const rows = catalog.providers.map((provider) => [
		provider.id,
		provider.type,
		hostOf(provider.base_url),
		provider.default_model ?? "-",
		describeAuth(provider.auth),
	]);
	printTable(["ID", "TYPE", "HOST", "DEFAULT MODEL", "AUTH"], rows);
}

export async function aiProviderAddCommand(
	providerId: string,
	opts: AiProviderAddOptions,
): Promise<void> {
	const provider = buildProvider(providerId, opts);
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const next = applyDefault(
		upsertAiProvider(catalog, provider, Boolean(opts.replace)),
		provider,
		opts,
	);
	writeAiProviderCatalog(next);
	printMutationResult("added", provider, opts.json);
}

export async function aiProviderEditCommand(
	providerId: string,
	opts: AiProviderEditOptions,
): Promise<void> {
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const existing = catalog.providers.find((provider) => provider.id === providerId);
	if (!existing) throw new Error(`AI Provider not found: ${providerId}`);
	const updated = buildProvider(providerId, opts, existing);
	const next = applyDefault(upsertAiProvider(catalog, updated, true), updated, opts);
	writeAiProviderCatalog(next);
	printMutationResult("updated", updated, opts.json);
}

export async function aiProviderRemoveCommand(
	providerId: string,
	opts: AiProviderRemoveOptions = {},
): Promise<void> {
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const next = removeAiProvider(catalog, providerId, Boolean(opts.force));
	writeAiProviderCatalog(next);
	if (opts.json) {
		console.log(JSON.stringify({ removed: providerId }, null, 2));
		return;
	}
	console.log(chalk.green(`✓ Removed AI Provider ${providerId}`));
}

export async function aiProviderValidateCommand(
	providerId?: string,
	opts: AiProviderValidateOptions = {},
): Promise<void> {
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const target = providerId ? catalogForProvider(catalog, providerId) : catalog;
	const result = validateAiProviderCatalog(target, {
		allowNoAuthPublic: Boolean(opts.allowNoAuthPublic),
	});
	if (opts.json) {
		console.log(JSON.stringify(result, null, 2));
	}
	for (const warning of result.warnings) {
		if (!opts.json) console.log(chalk.yellow(`warning: ${warning}`));
	}
	if (!result.valid) {
		if (!opts.json) {
			for (const error of result.errors) console.log(chalk.red(`error: ${error}`));
		}
		throw new Error("AI Provider validation failed.");
	}
	if (!opts.json) {
		console.log(chalk.green("✓ AI Provider catalog is valid"));
	}
}

export async function aiProviderExportCommand(opts: AiProviderExportOptions = {}): Promise<void> {
	if (opts.includeSecrets) {
		if (!opts.secretPassphrase) {
			throw new Error("--include-secrets requires --secret-passphrase.");
		}
		if (!opts.out) {
			throw new Error(
				"--include-secrets requires --out so encrypted material is not dumped to stdout.",
			);
		}
	}
	if (opts.secretPassphrase && !opts.includeSecrets) {
		throw new Error("--secret-passphrase can only be used with --include-secrets.");
	}
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const exportPayload: AiProviderCatalog & {
		encrypted_secrets?: EncryptedSecretBundle;
	} = { ...catalog };
	if (opts.includeSecrets) {
		const passphrase = readSecretExportPassphrase(opts.secretPassphraseEnv);
		exportPayload.encrypted_secrets = encryptSecretBundle(passphrase, collectEnvSecrets(catalog));
	}
	const output = `${JSON.stringify(exportPayload, null, 2)}\n`;
	if (opts.out) {
		writePrivateFile(opts.out, output);
		console.log(chalk.green(`✓ Exported AI Provider catalog to ${opts.out}`));
		return;
	}
	process.stdout.write(output);
}

export async function aiProviderImportCommand(
	file: string | undefined,
	opts: AiProviderImportOptions = {},
): Promise<void> {
	const sources = [file, opts.fromHermes, opts.fromOpenclaw].filter(Boolean);
	if (sources.length !== 1) {
		throw new Error("Pass exactly one import source: <file>, --from-hermes, or --from-openclaw.");
	}
	const fileInput = file ? (JSON.parse(readFileSync(file, "utf-8")) as unknown) : undefined;
	const incoming = opts.fromHermes
		? catalogFromHermesConfig(readFileSync(opts.fromHermes, "utf-8"))
		: opts.fromOpenclaw
			? catalogFromOpenClawConfig(JSON.parse(readFileSync(opts.fromOpenclaw, "utf-8")) as unknown)
			: coerceAiProviderCatalog(stripEncryptedSecrets(fileInput));
	if (opts.importSecrets && !file) {
		throw new Error("--import-secrets requires an AI Provider export file.");
	}
	const result = validateAiProviderCatalog(incoming);
	if (!result.valid) {
		throw new Error(`Imported AI Provider catalog is invalid:\n${result.errors.join("\n")}`);
	}
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	let next = catalog;
	for (const provider of incoming.providers) {
		next = upsertAiProvider(next, provider, Boolean(opts.replace));
	}
	if (incoming.defaults) {
		next = { ...next, defaults: { ...next.defaults, ...incoming.defaults } };
	}
	const secretImport =
		fileInput && opts.importSecrets
			? prepareEncryptedSecretImport(
					fileInput,
					opts.importSecrets,
					opts.out,
					opts.secretPassphraseEnv,
				)
			: undefined;
	writeAiProviderCatalog(next);
	if (secretImport) writePrivateFile(secretImport.out, secretImport.content);
	if (opts.json) {
		console.log(JSON.stringify({ imported: incoming.providers.length }, null, 2));
		return;
	}
	console.log(chalk.green(`✓ Imported ${incoming.providers.length} AI Provider(s)`));
}

export async function aiProviderTestCommand(
	providerId: string,
	opts: AiProviderTestOptions = {},
): Promise<void> {
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const provider = catalog.providers.find((entry) => entry.id === providerId);
	if (!provider) throw new Error(`AI Provider not found: ${providerId}`);
	const validation = validateAiProviderCatalog(catalogForProvider(catalog, providerId), {
		allowNoAuthPublic: false,
	});
	if (!validation.valid) {
		throw new Error(`AI Provider is invalid:\n${validation.errors.join("\n")}`);
	}
	const authStatus = await inspectAiProviderAuth(provider);
	const shouldProbe = opts.live === true || opts.probe === true;
	const providerProbe = shouldProbe
		? await probeAiProvider(provider, authStatus, parseAiProviderTestTimeout(opts.timeout))
		: { status: "skipped", detail: "live probe disabled; pass --live to call provider" };
	const result = {
		provider_id: provider.id,
		base_url: provider.base_url,
		auth: publicAiProviderAuthStatus(authStatus),
		model: opts.model ?? provider.default_model ?? null,
		provider_probe: providerProbe,
	};
	if (opts.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(`Provider: ${provider.id}`);
	console.log(`Endpoint: ${provider.base_url}`);
	console.log(`Auth: ${authStatus.status}${authStatus.detail ? ` (${authStatus.detail})` : ""}`);
	console.log(
		`Provider probe: ${providerProbe.status}${"detail" in providerProbe && providerProbe.detail ? ` (${providerProbe.detail})` : ""}`,
	);
}

export async function aiProviderImportAuthCommand(
	providerId: string,
	opts: AiProviderImportAuthOptions = {},
): Promise<void> {
	if (opts.project) {
		throw new Error("AI Provider auth is account-global; --project is not supported here.");
	}
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const provider = findProvider(catalog, providerId);
	const tool =
		opts.tool ?? (provider.auth.type === "agent_profile" ? provider.auth.tool : undefined);
	if (!tool) {
		throw new Error("--tool is required unless the provider already uses agent_profile auth.");
	}
	assertSupportedAgentProfileTool(canonicalAuthTool(tool) ?? tool);
	const profile =
		opts.profile ?? (provider.auth.type === "agent_profile" ? provider.auth.profile : "default");
	const collected = await collectAgentCredentialProfilePayload(tool, {
		profile,
		source: opts.source,
		from: opts.from,
		to: opts.to,
		keychainService: opts.keychainService,
		keychainAccount: opts.keychainAccount,
		yes: opts.yes,
		dryRun: opts.dryRun,
		json: opts.json,
		quiet: opts.json,
		destinationLabel: "AI Provider auth",
	});
	if (!collected) return;
	const nextProvider = await storeAgentProfileForProvider(provider, collected);
	writeAiProviderCatalog(upsertAiProvider(catalog, nextProvider, true));
	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					provider_id: providerId,
					auth: nextProvider.auth,
				},
				null,
				2,
			),
		);
		return;
	}
	console.log(
		chalk.green(
			`✓ Bound ${providerId} auth to agent profile ${collected.tool}/${collected.profile}`,
		),
	);
}

export async function aiProviderMaterializeAuthCommand(
	providerId: string,
	opts: AiProviderMaterializeAuthOptions = {},
): Promise<void> {
	if (opts.project) {
		throw new Error("AI Provider auth is account-global; --project is not supported here.");
	}
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const provider = findProvider(catalog, providerId);
	if (provider.auth.type !== "agent_profile") {
		throw new Error(
			`AI Provider ${providerId} does not use agent_profile auth. Current auth: ${describeAuth(provider.auth)}`,
		);
	}
	assertSupportedAgentProfileTool(provider.auth.tool);
	const profile = provider.auth.profile;
	const resolved = await new ApiClient().postJsonBody<AiProviderAuthResolveBackendResponse>(
		`/api/ai-providers/${encodeURIComponent(providerId)}/auth/resolve`,
		{ profile },
	);
	if (!resolved.payload) {
		throw new Error(`AI Provider ${providerId} auth resolve returned no credential payload.`);
	}
	await materializeAgentCredentialProfilePayload(
		resolved.tool ?? provider.auth.tool,
		resolved.profile ?? profile,
		resolved.payload,
		{
			to: opts.to,
			yes: opts.yes,
			dryRun: opts.dryRun,
			json: opts.json,
			backup: opts.backup,
		},
	);
}

export async function aiProviderConnectCommand(
	providerId: string,
	opts: AiProviderConnectOptions = {},
): Promise<void> {
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const provider = findProvider(catalog, providerId);
	const method = opts.method ?? "oauth";
	if (method !== "oauth") {
		throw new Error("AI Provider connect currently supports --method oauth.");
	}
	let callbackMode = parseOAuthCallbackMode(opts.callback ?? (opts.json ? "manual" : "loopback"));
	if (opts.redirectUri && callbackMode === "loopback") {
		throw new Error("--redirect-uri is only supported with --callback manual.");
	}
	const oauthProvider = canonicalAuthTool(opts.tool ?? defaultAuthTool(provider));
	if (!oauthProvider) {
		throw new Error("--tool is required for this provider type. Supported OAuth tool: codex.");
	}
	assertSupportedOAuthProvider(oauthProvider);
	let loopback: OAuthLoopbackServer | null = null;
	if (callbackMode === "loopback" && !opts.dryRun) {
		try {
			loopback = await createOAuthLoopbackServer(
				parseOAuthTimeout(opts.timeout),
				oauthLoopbackOptions(oauthProvider),
			);
		} catch (error) {
			callbackMode = "manual";
			if (!opts.json) {
				console.log(
					chalk.yellow(
						`Could not start the local OAuth callback: ${(error as Error).message}. Falling back to manual completion.`,
					),
				);
			}
		}
	}
	const redirectUri =
		loopback?.redirectUri ?? opts.redirectUri ?? defaultManualRedirectUri(oauthProvider);
	const request = {
		provider_id: providerId,
		method,
		provider: oauthProvider,
		callback: callbackMode,
		redirect_uri: redirectUri,
		dry_run: Boolean(opts.dryRun),
	};
	if (opts.dryRun) {
		console.log(JSON.stringify(request, null, 2));
		return;
	}
	try {
		const api = new ApiClient();
		await api.postJsonBody<AiProviderBackendResponse>(
			"/api/ai-providers",
			providerToBackendUpsert(provider),
			{ replace: "true" },
		);
		const started = await api.postJsonBody<AiProviderOAuthStartBackendResponse>(
			`/api/ai-providers/${encodeURIComponent(providerId)}/auth/oauth/start`,
			{
				provider: oauthProvider,
				redirect_uri: request.redirect_uri,
			},
		);
		if (opts.json) {
			console.log(JSON.stringify(started, null, 2));
			return;
		}
		console.log(chalk.green(`✓ Started OAuth for ${providerId}`));
		console.log(`Open: ${started.auth_url}`);
		if (!loopback) {
			console.log(
				chalk.gray(
					`After the browser redirects, complete with \`clawdi ai-provider complete-oauth ${providerId} --redirect-url <url>\`.`,
				),
			);
			return;
		}
		if (opts.open !== false) openInBrowser(started.auth_url);
		console.log(chalk.gray(`Waiting for OAuth callback on ${loopback.redirectUri}`));
		const callback = await loopback.wait();
		if (callback.error) {
			throw new Error(
				`OAuth provider returned ${callback.error}${callback.errorDescription ? `: ${callback.errorDescription}` : ""}`,
			);
		}
		if (!callback.code || !callback.state) {
			throw new Error("OAuth callback did not include code and state.");
		}
		const updated = await completeProviderOAuth(providerId, {
			code: callback.code,
			state: callback.state,
			redirectUri: loopback.redirectUri,
		});
		console.log(chalk.green(`✓ Connected OAuth profile for ${updated.id}`));
	} catch (error) {
		if (loopback?.timedOut(error)) {
			console.log(
				chalk.yellow(
					"Timed out waiting for the browser callback. If the browser shows a localhost URL, paste it with:",
				),
			);
			console.log(
				chalk.bold(`clawdi ai-provider complete-oauth ${providerId} --redirect-url <url>`),
			);
			return;
		}
		throw error;
	} finally {
		await loopback?.close();
	}
}

export async function aiProviderCompleteOAuthCommand(
	providerId: string,
	opts: AiProviderCompleteOAuthOptions = {},
): Promise<void> {
	const completion = parseOAuthCompletion(opts);
	const updated = await completeProviderOAuth(providerId, completion);
	if (opts.json) {
		console.log(JSON.stringify(updated, null, 2));
		return;
	}
	console.log(chalk.green(`✓ Connected OAuth profile for ${providerId}`));
}

interface OAuthCompletionInput {
	code: string;
	state: string;
	redirectUri?: string;
}

interface OAuthCallbackResult {
	code?: string;
	state?: string;
	error?: string;
	errorDescription?: string;
}

interface OAuthLoopbackServer {
	redirectUri: string;
	wait: () => Promise<OAuthCallbackResult>;
	close: () => Promise<void>;
	timedOut: (error: unknown) => boolean;
}

class OAuthCallbackTimeoutError extends Error {
	constructor() {
		super("Timed out waiting for OAuth callback.");
	}
}

async function completeProviderOAuth(
	providerId: string,
	completion: OAuthCompletionInput,
): Promise<AiProvider> {
	const api = new ApiClient();
	const response = await api.postJsonBody<AiProviderBackendResponse>(
		`/api/ai-providers/${encodeURIComponent(providerId)}/auth/oauth/complete`,
		{
			code: completion.code,
			state: completion.state,
			...(completion.redirectUri ? { redirect_uri: completion.redirectUri } : {}),
		},
	);
	const catalog = readAiProviderCatalog({ allowNoAuthPublic: true });
	const provider = findProvider(catalog, providerId);
	const updated = providerFromBackendResponse(provider, response);
	writeAiProviderCatalog(upsertAiProvider(catalog, updated, true));
	return updated;
}

function parseOAuthCompletion(opts: AiProviderCompleteOAuthOptions): OAuthCompletionInput {
	let code = opts.code;
	let state = opts.state;
	if (opts.redirectUrl) {
		let url: URL;
		try {
			url = new URL(opts.redirectUrl);
		} catch (error) {
			throw new Error(`Invalid --redirect-url: ${(error as Error).message}`);
		}
		const providerError = url.searchParams.get("error");
		if (providerError) {
			const description = url.searchParams.get("error_description");
			throw new Error(
				`OAuth provider returned ${providerError}${description ? `: ${description}` : ""}`,
			);
		}
		code = code ?? url.searchParams.get("code") ?? undefined;
		state = state ?? url.searchParams.get("state") ?? undefined;
	}
	if (!code || !state) {
		throw new Error("OAuth completion requires --redirect-url or both --code and --state.");
	}
	return {
		code,
		state,
		redirectUri: opts.redirectUri,
	};
}

async function createOAuthLoopbackServer(
	timeoutSeconds: number,
	options: OAuthLoopbackOptions,
): Promise<OAuthLoopbackServer> {
	let redirectOrigin = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let callbackResolved = false;
	let resolveCallback: (result: OAuthCallbackResult) => void = () => {};
	let rejectCallback: (error: Error) => void = () => {};
	const callbackPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
		resolveCallback = resolve;
		rejectCallback = reject;
	});
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", redirectOrigin);
		if (url.pathname !== options.path) {
			writeOAuthCallbackResponse(res, 404, "Not found");
			return;
		}
		if (callbackResolved) {
			writeOAuthCallbackResponse(
				res,
				200,
				"OAuth callback already received. You can close this tab.",
			);
			return;
		}
		callbackResolved = true;
		if (timer) clearTimeout(timer);
		const result: OAuthCallbackResult = {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
			error: url.searchParams.get("error") ?? undefined,
			errorDescription: url.searchParams.get("error_description") ?? undefined,
		};
		writeOAuthCallbackResponse(
			res,
			result.error ? 400 : 200,
			result.error
				? "OAuth returned an error. Return to your terminal for details."
				: "OAuth callback received. You can close this tab.",
		);
		resolveCallback(result);
	});

	const address = await listenOnPreferredPort(server, options);
	redirectOrigin = `http://${options.host}:${address.port}`;

	timer = setTimeout(() => {
		rejectCallback(new OAuthCallbackTimeoutError());
	}, timeoutSeconds * 1000);

	return {
		redirectUri: `${redirectOrigin}${options.path}`,
		wait: () => callbackPromise,
		close: () =>
			new Promise<void>((resolve) => {
				if (timer) clearTimeout(timer);
				server.close(() => resolve());
			}),
		timedOut: (error: unknown) => error instanceof OAuthCallbackTimeoutError,
	};
}

async function listenOnPreferredPort(
	server: ReturnType<typeof createServer>,
	options: OAuthLoopbackOptions,
): Promise<AddressInfo> {
	let lastError: unknown;
	for (let index = 0; index < options.ports.length; index += 1) {
		const port = options.ports[index];
		try {
			return await listenOnPort(server, options.host, port);
		} catch (error) {
			lastError = error;
			if (errorCode(error) !== "EADDRINUSE" || index === options.ports.length - 1) {
				break;
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error("No available OAuth callback port.");
}

async function listenOnPort(
	server: ReturnType<typeof createServer>,
	host: string,
	port: number,
): Promise<AddressInfo> {
	return await new Promise<AddressInfo>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Could not determine loopback callback port."));
				return;
			}
			resolve(address);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function writeOAuthCallbackResponse(
	res: ServerResponse,
	statusCode: number,
	message: string,
): void {
	res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
	res.end(
		`<!doctype html><meta charset="utf-8"><title>Clawdi OAuth</title><body>${escapeHtml(message)}</body>`,
	);
}

function parseOAuthCallbackMode(input: string): "loopback" | "manual" {
	if (input === "loopback" || input === "manual") return input;
	throw new Error("Invalid --callback. Supported modes: loopback, manual.");
}

function parseOAuthTimeout(input: string | undefined): number {
	const timeout = Number(input ?? 600);
	if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) {
		throw new Error("--timeout must be a number of seconds between 1 and 3600.");
	}
	return timeout;
}

function openInBrowser(url: string): void {
	const cmd =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	try {
		const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			/* Browser opener is best-effort; terminal URL remains visible. */
		});
		child.unref();
	} catch {
		/* Same as above. */
	}
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

async function storeAgentProfileForProvider(
	provider: AiProvider,
	collected: NonNullable<Awaited<ReturnType<typeof collectAgentCredentialProfilePayload>>>,
): Promise<AiProvider> {
	const api = new ApiClient();
	await api.postJsonBody<AiProviderBackendResponse>(
		"/api/ai-providers",
		providerToBackendUpsert(provider),
		{ replace: "true" },
	);
	const response = await api.postJsonBody<AiProviderBackendResponse>(
		`/api/ai-providers/${encodeURIComponent(provider.id)}/auth/import`,
		{
			type: "agent_profile",
			tool: collected.tool,
			profile: collected.profile,
			payload: collected.payload,
		},
	);
	return providerFromBackendResponse(provider, response);
}

function providerToBackendUpsert(provider: AiProvider): Record<string, unknown> {
	return {
		provider_id: provider.id,
		type: provider.type,
		label: provider.label,
		base_url: provider.base_url,
		default_model: provider.default_model,
		api_mode: provider.api_mode,
		auth: provider.auth,
		managed_by: provider.managed_by ?? "user",
		runtime_env_name: provider.runtime_env_name,
		capabilities: provider.capabilities,
	};
}

function providerFromBackendResponse(
	provider: AiProvider,
	response: AiProviderBackendResponse,
): AiProvider {
	const next: AiProvider = {
		...provider,
		auth: response.auth,
	};
	if (response.runtime_env_name !== undefined && response.runtime_env_name !== null) {
		next.runtime_env_name = response.runtime_env_name;
	}
	return next;
}

function buildProvider(
	providerId: string,
	opts: AiProviderAddOptions | AiProviderEditOptions,
	existing?: AiProvider,
): AiProvider {
	if (!isAiProviderId(providerId)) throw new Error(`Invalid AI Provider id: ${providerId}`);
	const type = parseProviderType(opts.type ?? existing?.type);
	const apiMode = parseApiMode(
		opts.apiMode ?? existing?.api_mode ?? defaultAiProviderApiMode(type),
	);
	const baseUrl = opts.baseUrl ?? existing?.base_url ?? defaultAiProviderBaseUrl(type);
	if (!baseUrl) throw new Error(`--base-url is required for provider type ${type}.`);
	const auth = opts.auth ? parseAuth(opts.auth) : existing?.auth;
	if (!auth)
		throw new Error(
			"--auth is required. Use env:<NAME>, clawdi://..., agent:codex/<profile>, or none.",
		);
	const provider: AiProvider = {
		id: providerId,
		type,
		base_url: baseUrl,
		auth,
	};
	if (opts.label ?? existing?.label) provider.label = opts.label ?? existing?.label;
	if (opts.defaultModel ?? existing?.default_model) {
		provider.default_model = opts.defaultModel ?? existing?.default_model;
	}
	if (apiMode) provider.api_mode = apiMode;
	const agentEnv = opts.agentEnv ?? existing?.runtime_env_name;
	if (agentEnv) {
		if (!isRuntimeEnvName(agentEnv)) throw new Error(`Invalid agent env name: ${agentEnv}`);
		provider.runtime_env_name = agentEnv;
	}
	const capabilities = parseCapabilities(opts.capability);
	if (capabilities ?? existing?.capabilities) {
		provider.capabilities = capabilities ?? existing?.capabilities;
	}
	return provider;
}

function parseProviderType(input: string | undefined): AiProviderType {
	if (!input || !isAiProviderType(input)) {
		throw new Error(
			`Invalid or missing --type. Supported types: openai, anthropic, openrouter, gemini, mistral, custom_openai_compatible.`,
		);
	}
	return input;
}

function parseApiMode(input: string | undefined): AiProviderApiMode | undefined {
	if (!input) return undefined;
	if (!isAiProviderApiMode(input)) {
		throw new Error(
			`Invalid --api-mode. Supported modes: openai_chat, openai_responses, anthropic_messages, google_generate_content.`,
		);
	}
	return input;
}

function parseAuth(input: string): AiProviderAuth {
	if (input === "none") return { type: "none" };
	if (isSupportedSecretRef(input)) return { type: "secret_ref", ref: input };
	if (input.startsWith("oauth:")) {
		throw new Error("Direct oauth_profile auth is not supported. Use connect for Codex OAuth.");
	}
	if (input.startsWith("agent:")) {
		const { provider, profile } = parseProfileRef(input.slice("agent:".length));
		assertSupportedAgentProfileTool(provider);
		return { type: "agent_profile", tool: provider, profile };
	}
	throw new Error(
		"Unsupported --auth. Use env:<NAME>, clawdi://..., agent:codex/<profile>, or none.",
	);
}

function parseProfileRef(input: string): { provider: string; profile: string } {
	const [provider, profile = "default", extra] = input.split("/");
	if (!provider || extra !== undefined) {
		throw new Error("Profile auth must use <provider>/<profile>.");
	}
	if (!isProviderAuthProfileId(provider) || !isProviderAuthProfileId(profile)) {
		throw new Error(
			"Profile auth provider and profile must use lowercase letters, numbers, dots, underscores, or hyphens.",
		);
	}
	return { provider, profile };
}

function canonicalAuthTool(input: string | undefined): string | undefined {
	if (!input) return undefined;
	const normalized = input.trim().toLowerCase().replace(/_/g, "-");
	if (normalized === "claude" || normalized === "claudecode") return "claude-code";
	if (normalized === "github" || normalized === "github-cli") return "gh";
	return normalized;
}

function defaultAuthTool(provider: AiProvider): string | undefined {
	if (provider.type === "openai") return CODEX_OAUTH_PROVIDER;
	return undefined;
}

function assertSupportedOAuthProvider(oauthProvider: string): void {
	if (oauthProvider === CODEX_OAUTH_PROVIDER) return;
	throw new Error(
		`AI Provider OAuth currently supports Codex only. Use API key, env:, or clawdi:// auth for ${oauthProvider}.`,
	);
}

function assertSupportedAgentProfileTool(tool: string): void {
	if (tool === CODEX_AGENT_PROFILE_TOOL) return;
	throw new Error(
		`AI Provider auth profiles currently support Codex only. Use API key, env:, clawdi:// auth, or legacy agent credential commands for ${tool}.`,
	);
}

function oauthLoopbackOptions(oauthProvider: string): OAuthLoopbackOptions {
	assertSupportedOAuthProvider(oauthProvider);
	return CODEX_OAUTH_LOOPBACK;
}

function defaultManualRedirectUri(oauthProvider: string): string {
	const options = oauthLoopbackOptions(oauthProvider);
	return `http://${options.host}:${options.ports[0]}${options.path}`;
}

function parseCapabilities(values: string[] | undefined): AiProviderCapabilities | undefined {
	if (!values || values.length === 0) return undefined;
	const out: AiProviderCapabilities = {};
	for (const raw of values.flatMap((value) => value.split(","))) {
		const key = raw.trim();
		if (!key) continue;
		if (
			key === "chat" ||
			key === "responses" ||
			key === "tools" ||
			key === "vision" ||
			key === "embeddings" ||
			key === "image_generation"
		) {
			out[key] = true;
			continue;
		}
		throw new Error(`Unsupported capability: ${key}`);
	}
	return out;
}

function applyDefault(
	catalog: AiProviderCatalog,
	provider: AiProvider,
	opts: { setDefault?: boolean },
): AiProviderCatalog {
	if (!opts.setDefault) return catalog;
	return {
		...catalog,
		defaults: {
			...catalog.defaults,
			chat_provider_id: provider.id,
		},
	};
}

function catalogForProvider(catalog: AiProviderCatalog, providerId: string): AiProviderCatalog {
	const provider = findProvider(catalog, providerId);
	return {
		...catalog,
		providers: [provider],
		defaults: undefined,
	};
}

interface SecretExportPayload {
	schema_version: 1;
	secrets: Array<{
		provider_id: string;
		ref: string;
		env_name: string;
		value: string;
	}>;
}

interface EncryptedSecretBundle {
	schema_version: 1;
	algorithm: "aes-256-gcm+scrypt";
	kdf: {
		name: "scrypt";
		salt: string;
		key_length: 32;
	};
	nonce: string;
	ciphertext: string;
	auth_tag: string;
}

function collectEnvSecrets(catalog: AiProviderCatalog): SecretExportPayload {
	const secrets: SecretExportPayload["secrets"] = [];
	for (const provider of catalog.providers) {
		const ref = exportableEnvRef(provider.auth);
		if (!ref) continue;
		const envName = ref.slice("env:".length);
		const value = process.env[envName];
		if (!value) {
			throw new Error(`Cannot include secrets: ${ref} is not set in the current environment.`);
		}
		secrets.push({ provider_id: provider.id, ref, env_name: envName, value });
	}
	return { schema_version: 1, secrets };
}

function exportableEnvRef(auth: AiProviderAuth): string | null {
	if (auth.type === "secret_ref") {
		if (auth.ref.startsWith("env:")) return auth.ref;
		if (auth.ref.startsWith("clawdi://")) {
			throw new Error(
				"Provider-only encrypted export does not resolve clawdi:// refs. Export/import keeps those refs and leaves the Vault secret in Vault.",
			);
		}
	}
	if (auth.type === "api_key") {
		if (auth.source === "env" && auth.ref?.startsWith("env:")) return auth.ref;
		if (auth.source === "vault" || auth.source === "managed") {
			throw new Error(
				"Provider-only encrypted export currently supports env-backed provider secrets only.",
			);
		}
	}
	return null;
}

function readSecretExportPassphrase(envName = "CLAWDI_SECRET_EXPORT_PASSPHRASE"): string {
	const passphrase = process.env[envName];
	if (!passphrase) {
		throw new Error(`Set ${envName} to use --secret-passphrase.`);
	}
	return passphrase;
}

function encryptSecretBundle(
	passphrase: string,
	payload: SecretExportPayload,
): EncryptedSecretBundle {
	const salt = randomBytes(16);
	const nonce = randomBytes(12);
	const key = scryptSync(passphrase, salt, 32);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(payload), "utf-8"),
		cipher.final(),
	]);
	return {
		schema_version: 1,
		algorithm: "aes-256-gcm+scrypt",
		kdf: {
			name: "scrypt",
			salt: salt.toString("base64"),
			key_length: 32,
		},
		nonce: nonce.toString("base64"),
		ciphertext: ciphertext.toString("base64"),
		auth_tag: cipher.getAuthTag().toString("base64"),
	};
}

function decryptSecretBundle(
	passphrase: string,
	bundle: EncryptedSecretBundle,
): SecretExportPayload {
	if (
		bundle.schema_version !== 1 ||
		bundle.algorithm !== "aes-256-gcm+scrypt" ||
		bundle.kdf?.name !== "scrypt" ||
		bundle.kdf.key_length !== 32
	) {
		throw new Error("Unsupported encrypted secret export format.");
	}
	const salt = Buffer.from(bundle.kdf.salt, "base64");
	const nonce = Buffer.from(bundle.nonce, "base64");
	const key = scryptSync(passphrase, salt, 32);
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAuthTag(Buffer.from(bundle.auth_tag, "base64"));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(bundle.ciphertext, "base64")),
		decipher.final(),
	]).toString("utf-8");
	const parsed = JSON.parse(plaintext) as unknown;
	const payload = asRecord(parsed, "secret export payload");
	if (payload.schema_version !== 1 || !Array.isArray(payload.secrets)) {
		throw new Error("Invalid decrypted secret export payload.");
	}
	const secrets = payload.secrets.map((entry) => {
		const secret = asRecord(entry, "secret export entry");
		if (
			typeof secret.provider_id !== "string" ||
			typeof secret.ref !== "string" ||
			typeof secret.env_name !== "string" ||
			typeof secret.value !== "string"
		) {
			throw new Error("Invalid decrypted secret export entry.");
		}
		if (!isRuntimeEnvName(secret.env_name) || secret.ref !== `env:${secret.env_name}`) {
			throw new Error("Invalid decrypted env secret metadata.");
		}
		return {
			provider_id: secret.provider_id,
			ref: secret.ref,
			env_name: secret.env_name,
			value: secret.value,
		};
	});
	return { schema_version: 1, secrets };
}

function stripEncryptedSecrets(input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
	const { encrypted_secrets: _encryptedSecrets, ...rest } = input as Record<string, unknown>;
	return rest;
}

function prepareEncryptedSecretImport(
	input: unknown,
	target: string,
	out: string | undefined,
	passphraseEnv: string | undefined,
): { out: string; content: string } {
	if (target !== "env-file") {
		throw new Error("Only --import-secrets env-file is supported in the provider-only path.");
	}
	if (!out) throw new Error("--import-secrets env-file requires --out <file>.");
	const root = asRecord(input, "AI Provider export");
	const bundle = root.encrypted_secrets;
	if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
		throw new Error("Export file does not contain encrypted_secrets.");
	}
	const payload = decryptSecretBundle(
		readSecretExportPassphrase(passphraseEnv),
		bundle as EncryptedSecretBundle,
	);
	const lines = payload.secrets.map((secret) => `${secret.env_name}=${shellQuote(secret.value)}`);
	return { out, content: `${lines.join("\n")}\n` };
}

function shellQuote(input: string): string {
	return `'${input.replace(/'/g, "'\\''")}'`;
}

function writePrivateFile(path: string, content: string): void {
	writePrivateFileAtomic(path, content, { mode: PRIVATE_FILE_MODE });
}

function catalogFromOpenClawConfig(input: unknown): AiProviderCatalog {
	const root = asRecord(input, "OpenClaw config");
	const models = asRecord(root.models, "OpenClaw models");
	const providerMap = asRecord(models.providers, "OpenClaw models.providers");
	const providers: AiProvider[] = [];
	for (const [id, value] of Object.entries(providerMap)) {
		if (!isAiProviderId(id)) continue;
		const entry = asRecord(value, `OpenClaw provider ${id}`);
		const type = parseProviderType(
			String(entry.type ?? entry.provider ?? "custom_openai_compatible"),
		);
		const baseUrl = stringField(entry, "baseUrl") ?? stringField(entry, "base_url");
		if (!baseUrl) continue;
		const apiModeInput = stringField(entry, "apiMode") ?? stringField(entry, "api_mode");
		const keyEnv = stringField(entry, "keyEnv") ?? stringField(entry, "key_env");
		const modelId = firstModelId(entry.models);
		const provider: AiProvider = {
			id,
			type,
			base_url: baseUrl,
			auth: keyEnv ? { type: "secret_ref", ref: `env:${keyEnv}` } : { type: "none" },
		};
		if (modelId) provider.default_model = modelId;
		const apiMode = parseApiMode(apiModeInput ?? defaultAiProviderApiMode(type));
		if (apiMode) provider.api_mode = apiMode;
		if (keyEnv) provider.runtime_env_name = keyEnv;
		providers.push(provider);
	}
	const defaults = defaultProviderFromOpenClaw(root);
	return { schema_version: 1, providers, defaults };
}

function catalogFromHermesConfig(content: string): AiProviderCatalog {
	let rootValue: unknown;
	try {
		rootValue = parseYaml(content);
	} catch (error) {
		throw new Error(
			`Hermes config is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const root = asRecord(rootValue, "Hermes config");
	const providers: AiProvider[] = [
		...providersFromHermesProvidersDict(recordField(root, "providers")),
		...providersFromHermesCustomProvidersList(root.custom_providers),
	];
	if (providers.length === 0) {
		throw new Error("Hermes config does not contain a providers block.");
	}
	const modelConfig = recordField(root, "model");
	const defaultProvider = modelConfig
		? normalizeHermesProviderSelector(stringField(modelConfig, "provider"))
		: undefined;
	return {
		schema_version: 1,
		providers,
		defaults: defaultProvider ? { chat_provider_id: defaultProvider } : undefined,
	};
}

function providersFromHermesProvidersDict(
	providerMap: Record<string, unknown> | undefined,
): AiProvider[] {
	if (!providerMap) return [];
	const providers: AiProvider[] = [];
	for (const [id, value] of Object.entries(providerMap)) {
		if (!isAiProviderId(id)) continue;
		const provider = asRecord(value, `Hermes provider ${id}`);
		const entry = providerFromHermesEntry(id, provider);
		if (entry) providers.push(entry);
	}
	return providers;
}

function providersFromHermesCustomProvidersList(input: unknown): AiProvider[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) throw new Error("Hermes custom_providers must be a list.");
	const providers: AiProvider[] = [];
	for (const value of input) {
		const provider = asRecord(value, "Hermes custom provider");
		const name = stringField(provider, "name");
		if (!name) continue;
		const id = hermesProviderIdFromName(name);
		const entry = providerFromHermesEntry(id, provider);
		if (entry) providers.push(entry);
	}
	return providers;
}

function providerFromHermesEntry(
	id: string,
	provider: Record<string, unknown>,
): AiProvider | undefined {
	const baseUrl =
		stringField(provider, "api") ??
		stringField(provider, "url") ??
		stringField(provider, "base_url") ??
		stringField(provider, "baseUrl");
	if (!baseUrl) return undefined;
	const keyEnv = stringField(provider, "key_env") ?? stringField(provider, "api_key_env");
	const type = parseProviderType(
		stringField(provider, "type") ?? inferProviderTypeFromEndpoint(id, baseUrl, provider),
	);
	const entry: AiProvider = {
		id,
		type,
		base_url: baseUrl,
		auth: keyEnv ? { type: "secret_ref", ref: `env:${keyEnv}` } : { type: "none" },
	};
	const model =
		stringField(provider, "default_model") ??
		stringField(provider, "model") ??
		stringField(provider, "default");
	if (model) entry.default_model = model;
	const apiMode = parseApiMode(
		aiApiModeFromHermesTransport(stringField(provider, "transport")) ??
			stringField(provider, "api_mode") ??
			defaultAiProviderApiMode(type),
	);
	if (apiMode) entry.api_mode = apiMode;
	if (keyEnv) entry.runtime_env_name = keyEnv;
	const name = stringField(provider, "name");
	if (name) entry.label = name;
	return entry;
}

function inferProviderTypeFromEndpoint(
	id: string,
	baseUrl: string,
	provider: Record<string, unknown>,
): AiProviderType {
	const normalizedId = id.toLowerCase();
	const host = hostOf(baseUrl).toLowerCase();
	const transport = stringField(provider, "transport") ?? stringField(provider, "api_mode");
	if (normalizedId.includes("openrouter") || host.includes("openrouter.ai")) return "openrouter";
	if (normalizedId.includes("mistral") || host.includes("mistral.ai")) return "mistral";
	if (normalizedId.includes("gemini") || host.includes("generativelanguage.googleapis.com"))
		return "gemini";
	if (normalizedId.includes("anthropic") || host.includes("anthropic.com")) return "anthropic";
	if (normalizedId.includes("openai") || host.includes("api.openai.com")) return "openai";
	if (transport === "anthropic_messages") return "anthropic";
	return "custom_openai_compatible";
}

function aiApiModeFromHermesTransport(input: string | undefined): AiProviderApiMode | undefined {
	if (input === "chat_completions") return "openai_chat";
	if (input === "codex_responses") return "openai_responses";
	if (input === "anthropic_messages") return "anthropic_messages";
	return undefined;
}

function normalizeHermesProviderSelector(input: string | undefined): string | undefined {
	if (!input) return undefined;
	const providerId = input.startsWith("custom:") ? input.slice("custom:".length) : input;
	return isAiProviderId(providerId) ? providerId : undefined;
}

function hermesProviderIdFromName(name: string): string {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/-+/g, "-")
		.replace(/[-.]+$/g, "");
	const candidate = normalized.slice(0, 63).replace(/[-.]+$/g, "");
	if (isAiProviderId(candidate)) return candidate;
	const suffix = candidate
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 54)
		.replace(/[-.]+$/g, "");
	const fallback = `provider-${suffix || "custom"}`.slice(0, 63).replace(/[-.]+$/g, "");
	return isAiProviderId(fallback) ? fallback : "provider-custom";
}

function recordField(
	record: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	return asRecord(value, key);
}

function findProvider(catalog: AiProviderCatalog, providerId: string): AiProvider {
	const provider = catalog.providers.find((entry) => entry.id === providerId);
	if (!provider) throw new Error(`AI Provider not found: ${providerId}`);
	return provider;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstModelId(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const first = value[0];
	if (typeof first === "string") return first;
	if (typeof first === "object" && first !== null && "id" in first) {
		const id = (first as { id?: unknown }).id;
		return typeof id === "string" ? id : undefined;
	}
	return undefined;
}

function defaultProviderFromOpenClaw(root: Record<string, unknown>): AiProviderCatalog["defaults"] {
	const agents = root.agents;
	if (typeof agents !== "object" || agents === null || Array.isArray(agents)) return undefined;
	const defaults = (agents as Record<string, unknown>).defaults;
	if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults))
		return undefined;
	const model = (defaults as Record<string, unknown>).model;
	if (typeof model !== "string") return undefined;
	const providerId = model.split("/")[0];
	return isAiProviderId(providerId) ? { chat_provider_id: providerId } : undefined;
}

function describeAuth(auth: AiProviderAuth): string {
	if (auth.type === "secret_ref") return redactRef(auth.ref);
	if (auth.type === "api_key") return `api_key:${auth.source}`;
	if (auth.type === "oauth_profile") return `oauth:${auth.provider}/${auth.profile}`;
	if (auth.type === "agent_profile") return `agent:${auth.tool}/${auth.profile}`;
	return "none";
}

function redactRef(ref: string): string {
	if (ref.startsWith("env:")) return ref;
	if (ref.startsWith("clawdi://")) return "clawdi://...";
	return "redacted";
}

function hostOf(input: string): string {
	try {
		return new URL(input).host;
	} catch {
		return input;
	}
}

function printMutationResult(action: string, provider: AiProvider, json?: boolean): void {
	if (json) {
		console.log(JSON.stringify({ [action]: provider.id, provider }, null, 2));
		return;
	}
	console.log(chalk.green(`✓ ${capitalize(action)} AI Provider ${provider.id}`));
	console.log(chalk.dim(`Catalog: ${aiProviderCatalogPath()}`));
}

function printTable(headers: string[], rows: string[][]): void {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
	);
	const line = (cells: string[]) =>
		cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");
	console.log(line(headers));
	console.log(line(headers.map((header) => "-".repeat(header.length))));
	for (const row of rows) console.log(line(row));
}

function capitalize(input: string): string {
	return `${input.slice(0, 1).toUpperCase()}${input.slice(1)}`;
}
