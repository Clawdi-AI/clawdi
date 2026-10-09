import { accessSync, constants, existsSync } from "node:fs";
import * as p from "@clack/prompts";
import type { components } from "@clawdi/shared/api";
import chalk from "chalk";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { normalizeCloudApiBaseUrl } from "../lib/api-origin";
import { openInBrowser } from "../lib/browser";
import {
	ClerkOAuthError,
	captureStoredCredentialIdentity,
	clearPendingClerkOAuthLogin,
	commitClawdiCredential,
	createCredentialEndpointBinding,
	describeCredentialEndpointBinding,
	fetchClerkOAuthClientConfig,
	fetchClerkOAuthDiscovery,
	isClerkOAuthAuth,
	logoutClawdiCredentials,
	persistClerkDeviceSlowDown,
	persistPendingClerkOAuthLogin,
	pollClerkDeviceToken,
	type StoredCredentialIdentity,
	startClerkDeviceAuthorization,
	verifyAndPersistClerkOAuthLogin,
} from "../lib/clerk-oauth";
import { emit, wantsJson } from "../lib/command-output";
import { getAuth, getConfig, getPendingAuth, isLoggedIn, type PendingAuth } from "../lib/config";
import { detectRuntimeMode, getRuntimePaths } from "../runtime/paths";

type MeResponse = components["schemas"]["CurrentUserResponse"];

async function verifyAndSaveLegacy(
	apiKey: string,
	apiUrl: string,
	expectedCredential: StoredCredentialIdentity,
): Promise<MeResponse | null> {
	const endpointBinding = createCredentialEndpointBinding(apiUrl);
	const result = await new ApiClient({
		baseUrl: endpointBinding.cloudApiOrigin,
		authToken: apiKey,
	}).GET("/v1/auth/me");
	if (result.response.status === 401 || result.response.status === 410) {
		throw new ApiError({
			status: result.response.status,
			body: JSON.stringify(result.error ?? {}),
			hint: "Verify your existing key, or run `clawdi auth login` (use `--no-open` on a server).",
		});
	}
	if (!result.response.ok) return null;
	const me = unwrap(result);
	await commitClawdiCredential(
		{ apiKey, userId: me.id, email: me.email ?? undefined, endpointBinding },
		expectedCredential,
	);
	return me;
}

function loginMessage(message: string): void {
	if (process.stdout.isTTY && process.stdin.isTTY) {
		p.log.message(message, { output: process.stderr });
	} else {
		console.log(message);
	}
}

function postLoginHint() {
	loginMessage("Next: clawdi setup to register this machine.");
	if (process.stdout.isTTY && process.stdin.isTTY) {
		p.outro(chalk.gray("Credentials saved to ~/.clawdi/auth.json"), { output: process.stderr });
	} else {
		console.log("Credentials saved to ~/.clawdi/auth.json");
	}
}

async function authLoginManual(apiUrl: string, expectedCredential: StoredCredentialIdentity) {
	p.log.message(
		"API keys can no longer be created. Run `clawdi auth login` " +
			"(use `--no-open` on a server). Existing keys keep working until revoked.",
		{ output: process.stderr },
	);

	const apiKey = await p.password({
		output: process.stderr,
		message: "Paste an existing API key",
		validate: (v) => (v?.trim() ? undefined : "API key cannot be empty"),
	});
	if (p.isCancel(apiKey)) {
		p.cancel("Cancelled.", { output: process.stderr });
		return;
	}

	const verifySpinner = p.spinner({ output: process.stderr });
	verifySpinner.start("Verifying...");
	const trimmed = apiKey.trim();
	let me: MeResponse | null = null;
	try {
		me = await verifyAndSaveLegacy(trimmed, apiUrl, expectedCredential);
	} catch (e) {
		if (e instanceof ApiError) {
			verifySpinner.stop(chalk.red(e.status === 410 ? "Sign-in unavailable" : "Invalid API key"));
			p.log.message(chalk.gray(e.hint), { output: process.stderr });
			p.outro(chalk.red("Aborted."), { output: process.stderr });
			process.exitCode = 1;
			return;
		}
		const msg = e instanceof Error ? e.message : String(e);
		verifySpinner.stop(chalk.red("Could not reach the API"));
		p.log.error(`Network error: ${msg}`, { output: process.stderr });
		p.log.message(chalk.gray(`Current API URL: ${apiUrl}`), { output: process.stderr });
		p.log.message(chalk.gray("If this is wrong, run `clawdi config unset apiUrl` and try again."), {
			output: process.stderr,
		});
		p.outro(chalk.red("Aborted."), { output: process.stderr });
		process.exitCode = 1;
		return;
	}

	if (!me) {
		verifySpinner.stop(chalk.red("Invalid API key"));
		p.log.message(
			chalk.gray(
				"Verify your existing key, or run `clawdi auth login` (use `--no-open` on a server).",
			),
			{ output: process.stderr },
		);
		p.log.message(chalk.gray(`Current API URL: ${apiUrl}`), { output: process.stderr });
		p.outro(chalk.red("Aborted."), { output: process.stderr });
		process.exitCode = 1;
		return;
	}

	verifySpinner.stop(chalk.green(`Signed in as ${me.email || me.name || me.id}`));
	postLoginHint();
}

function isSshSession(): boolean {
	return Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

async function startOAuthLogin(
	apiUrl: string,
	hostedApiUrl: string,
	expectedCredential: StoredCredentialIdentity,
	signal?: AbortSignal,
): Promise<PendingAuth> {
	const endpointBinding = createCredentialEndpointBinding(apiUrl, hostedApiUrl);
	if (!endpointBinding.hostedApiOrigin) {
		throw new ClerkOAuthError(
			"invalid_credential_endpoint_binding",
			"OAuth sign-in requires a CLAWDI_DEPLOY_API_URL binding.",
		);
	}
	const clientConfig = await fetchClerkOAuthClientConfig(endpointBinding.cloudApiOrigin, {
		signal,
	});
	const discovery = await fetchClerkOAuthDiscovery(clientConfig, { signal });
	const pending = await startClerkDeviceAuthorization({
		config: clientConfig,
		discovery,
		apiUrl: endpointBinding.cloudApiOrigin,
		hostedApiUrl: endpointBinding.hostedApiOrigin,
		signal,
	});
	await persistPendingClerkOAuthLogin(pending, expectedCredential);
	if (signal?.aborted) {
		await clearPendingClerkOAuthLogin(pending);
		throw new ClerkOAuthError("oauth_cancelled", "Clawdi sign-in was cancelled.");
	}
	return pending;
}

function printDeviceInstructions(pending: PendingAuth): void {
	const seconds = Math.max(0, Math.ceil((Date.parse(pending.expiresAt) - Date.now()) / 1_000));
	const lifetime = seconds >= 60 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`;
	loginMessage(
		"Sign in to Clawdi\n" +
			`Open:  ${pending.verificationUriComplete ?? pending.verificationUri}\n` +
			`Code:  ${pending.userCode}   (check that the page shows the same code)\n` +
			`Approve only if you started this sign-in on this machine just now. It expires in ${lifetime}.\n` +
			"Waiting for approval…",
	);
}

async function runDeviceLogin(
	pending: PendingAuth,
	expected: StoredCredentialIdentity,
	ui: {
		open: boolean;
		quiet: boolean;
		signal?: AbortSignal;
		progress?: (pending: PendingAuth) => void;
	},
): Promise<void> {
	if (!ui.quiet) printDeviceInstructions(pending);
	ui.progress?.(pending);
	if (ui.open) openInBrowser(pending.verificationUriComplete ?? pending.verificationUri);
	let auth: Awaited<ReturnType<typeof pollClerkDeviceToken>>;
	try {
		auth = await pollClerkDeviceToken(pending, {
			onSlowDown: persistClerkDeviceSlowDown,
			signal: ui.signal,
		});
	} catch (error) {
		await clearPendingClerkOAuthLogin(pending);
		throw error;
	}

	let verification: Awaited<ReturnType<typeof verifyAndPersistClerkOAuthLogin>>;
	try {
		verification = await verifyAndPersistClerkOAuthLogin(pending.apiUrl, auth, {
			expectedCredential: expected,
			pending,
		});
	} catch (error) {
		const current = getAuth();
		if (
			error instanceof ClerkOAuthError &&
			error.code === "credential_state_changed" &&
			isClerkOAuthAuth(current) &&
			current.userId === auth.userId
		) {
			if (!ui.quiet) {
				loginMessage(`Signed in as ${current.email || current.userId}`);
				postLoginHint();
			}
			return;
		}
		throw error;
	}
	if (ui.quiet) return;
	if (verification.kind === "cloud_unverified") {
		loginMessage("Signed in; Clawdi couldn't verify your profile right now.");
		loginMessage(
			"The Clerk grant is saved, but Clawdi hasn't verified it. Run `clawdi auth status` and retry a command when the service recovers.",
		);
	} else {
		const me = verification.user;
		loginMessage(`Signed in as ${me.email || me.name || me.id}`);
	}
	postLoginHint();
}

function reportOAuthError(error: unknown): void {
	const message =
		error instanceof ClerkOAuthError
			? error.message
			: "Clawdi sign-in could not be completed. Run `clawdi auth login` again.";
	if (process.stdout.isTTY && process.stdin.isTTY) {
		p.log.error(message, { output: process.stderr });
	} else {
		console.error(message);
	}
	process.exitCode = 1;
}

export async function authLogin(opts: { manual?: boolean; open?: boolean } = {}) {
	const existing = getAuth();
	if (existing) {
		p.log.warn(`Already signed in as ${existing.email || existing.userId || "unknown"}`, {
			output: process.stderr,
		});
		p.log.info("Run `clawdi auth logout` first to switch accounts.", { output: process.stderr });
		return;
	}
	const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
	if (opts.manual && !interactive) {
		p.log.error("`clawdi auth login --manual` needs an interactive terminal.", {
			output: process.stderr,
		});
		p.log.message(
			chalk.gray("Run the command in a TTY, or use the default device flow without --manual."),
			{ output: process.stderr },
		);
		process.exitCode = 1;
		return;
	}
	const config = getConfig();
	const expected = captureStoredCredentialIdentity();
	if (opts.manual) {
		p.intro(chalk.bold("clawdi auth login"), { output: process.stderr });
		await authLoginManual(config.apiUrl, expected);
		return;
	}
	try {
		const pending = await startOAuthLogin(config.apiUrl, config.deployApiUrl, expected);
		await runDeviceLogin(pending, expected, {
			open: interactive && opts.open !== false && !isSshSession(),
			quiet: false,
		});
	} catch (error) {
		reportOAuthError(error);
	}
}

export async function authComplete() {
	const existing = getAuth();
	if (existing) {
		loginMessage(`Already signed in as ${existing.email || existing.userId || "unknown"}.`);
		return;
	}
	const pending = getPendingAuth();
	if (!pending) {
		reportOAuthError(
			new ClerkOAuthError("no_pending_auth", "No pending sign-in. Run `clawdi auth login`."),
		);
		return;
	}
	try {
		if (
			!Number.isFinite(Date.parse(pending.expiresAt)) ||
			Date.parse(pending.expiresAt) <= Date.now()
		) {
			await clearPendingClerkOAuthLogin(pending);
			throw new ClerkOAuthError(
				"oauth_login_expired",
				"The code expired. Run `clawdi auth login` again.",
			);
		}
		await runDeviceLogin(pending, { kind: "none" }, { open: false, quiet: false });
	} catch (error) {
		reportOAuthError(error);
	}
}

export async function authLoginDesktop(opts: { force?: boolean } = {}): Promise<void> {
	const existing = getAuth();
	if (!isClerkOAuthAuth(existing) || opts.force) {
		const config = getConfig();
		const expected = captureStoredCredentialIdentity();

		const controller = new AbortController();
		const cancel = () => controller.abort();
		process.once("SIGTERM", cancel);
		process.once("SIGINT", cancel);
		try {
			const pending = await startOAuthLogin(
				config.apiUrl,
				config.deployApiUrl,
				expected,
				controller.signal,
			);
			await runDeviceLogin(pending, expected, {
				open: true,
				quiet: true,
				signal: controller.signal,
				progress: (pending) =>
					emit(
						{
							schemaVersion: "clawdi.desktopLogin.progress.v1",
							verificationUri: pending.verificationUriComplete ?? pending.verificationUri,
							userCode: pending.userCode,
							expiresAt: pending.expiresAt,
						},
						console.error,
					),
			});
		} catch (error) {
			if (
				controller.signal.aborted ||
				(error instanceof ClerkOAuthError &&
					["oauth_denied", "oauth_cancelled"].includes(error.code))
			) {
				emit({ schemaVersion: "clawdi.desktopLogin.v1", status: "cancelled" });
				return;
			}
			throw error;
		} finally {
			process.off("SIGTERM", cancel);
			process.off("SIGINT", cancel);
		}
	}
	const auth = getAuth();
	if (!isClerkOAuthAuth(auth)) throw new Error("Desktop sign-in did not save an OAuth session.");
	emit({
		schemaVersion: "clawdi.desktopLogin.v1",
		status: "authenticated",
		user: { id: auth.userId, ...(auth.email ? { email: auth.email } : {}) },
	});
}

export async function authLogout() {
	if (!isLoggedIn()) {
		p.log.info("Not signed in.", { output: process.stderr });
		return;
	}

	// Warn about the singleton daemon before clearing credentials. The service
	// keeps its captured credential until it is uninstalled explicitly.
	const { isSingletonDaemonInstalled } = await import("../serve/installer");
	if (isSingletonDaemonInstalled()) {
		p.log.warn(
			"A daemon is still installed. " +
				`They keep running after sign-out and will fail to authenticate. ` +
				`Run \`clawdi daemon uninstall\` to stop them.`,
			{ output: process.stderr },
		);
	}

	const result = await logoutClawdiCredentials(getConfig().apiUrl);
	if (result.environmentCredential) {
		p.log.warn(
			"CLAWDI_AUTH_TOKEN controls this process. Unset it in the environment to sign out; persisted credentials were not changed.",
			{ output: process.stderr },
		);
		return;
	}
	if (result.remoteRevoked) p.log.success("Remote Clerk OAuth grant revoked.");
	else if (result.loggedOut) {
		p.log.warn(
			"Couldn't revoke the remote OAuth grant. The local credential was removed; revoke the Clawdi app in your Clerk account if needed.",
			{ output: process.stderr },
		);
	}
	p.log.success("Signed out. Credentials removed; this account's agent registrations were kept.");
}

type AuthStatusSource = "auth.json" | "CLAWDI_AUTH_TOKEN" | "runtime-auth-token" | "none";

function readable(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function detectAuthSource(paths: ReturnType<typeof getRuntimePaths>): AuthStatusSource {
	if (process.env.CLAWDI_AUTH_TOKEN) return "CLAWDI_AUTH_TOKEN";
	if (existsSync(paths.localAuth)) return "auth.json";
	if (readable(paths.daemonAuthToken)) return "runtime-auth-token";
	return "none";
}

export async function authStatus(opts: { json?: boolean } = {}) {
	const auth = getAuth();
	const config = getConfig();
	const mode = detectRuntimeMode();
	const paths = getRuntimePaths({ mode });
	const source = detectAuthSource(paths);
	const authenticated = Boolean(auth) || source === "runtime-auth-token";
	let safeApiUrl = "<invalid>";
	try {
		safeApiUrl = normalizeCloudApiBaseUrl(config.apiUrl);
	} catch {
		// Do not echo malformed raw URLs: userinfo could contain a password.
	}
	const payload = {
		schemaVersion: "clawdi.authStatus.v1",
		authenticated,
		source,
		credentialType: isClerkOAuthAuth(auth) ? "clerk-oauth" : auth ? "legacy-api-key" : undefined,
		endpointBinding: auth
			? describeCredentialEndpointBinding(auth, config.apiUrl, config.deployApiUrl)
			: undefined,
		apiUrl: safeApiUrl,
		runtimeMode: mode,
		user: auth ? { email: auth.email, id: auth.userId } : undefined,
		paths: {
			clawdiHome: paths.clawdiHome,
			auth: source === "auth.json" ? paths.localAuth : undefined,
			runtimeAuthTokenReadable: readable(paths.daemonAuthToken),
			runtimeAuthToken: "<redacted>",
		},
	};

	if (wantsJson(opts)) {
		emit(payload);
		return;
	}

	console.log(chalk.bold("clawdi auth status"));
	console.log();
	console.log(`  Authenticated: ${authenticated ? chalk.green("yes") : chalk.red("no")}`);
	console.log(`  Source: ${source}`);
	if (payload.credentialType) console.log(`  Credential: ${payload.credentialType}`);
	if (payload.endpointBinding) {
		console.log(`  Endpoint binding: ${payload.endpointBinding.state}`);
	}
	console.log(chalk.gray(`  API: ${safeApiUrl}`));
	if (auth?.email || auth?.userId) {
		console.log(chalk.gray(`  User: ${auth.email || auth.userId}`));
	}
}
