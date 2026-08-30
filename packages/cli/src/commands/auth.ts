import { accessSync, constants, existsSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient, readJson, unwrap } from "../lib/api-client";
import { normalizeCloudApiBaseUrl } from "../lib/api-origin";
import { openInBrowser } from "../lib/browser";
import {
	ClerkOAuthError,
	captureStoredCredentialIdentity,
	clearPendingClerkOAuthLogin,
	commitClawdiCredential,
	createClerkOAuthAuthorization,
	createCredentialEndpointBinding,
	describeCredentialEndpointBinding,
	exchangeClerkOAuthCode,
	fetchClerkOAuthClientConfig,
	fetchClerkOAuthDiscovery,
	isClerkOAuthAuth,
	logoutClawdiCredentials,
	persistPendingClerkOAuthLogin,
	type StoredCredentialIdentity,
	verifyAndPersistClerkOAuthLogin,
} from "../lib/clerk-oauth";
import { startClerkOAuthLoopback } from "../lib/clerk-oauth-loopback";
import {
	type ClerkOAuthAuth,
	getAuth,
	getConfig,
	getPendingAuth,
	isLoggedIn,
	type PendingAuth,
} from "../lib/config";
import { detectRuntimeMode, getRuntimePaths } from "../runtime/paths";

export { browserOpenCommand } from "../lib/browser";

interface MeResponse {
	id: string;
	email: string;
	name: string;
}

/**
 * Open a URL in the default browser. Best-effort: on headless machines or
 * when no opener is installed, the spawn silently no-ops and the user just
 * copies the URL out of the terminal. We don't want to crash the login flow
 * over a missing `xdg-open`.
 */
async function verifyAndSaveLegacy(
	apiKey: string,
	apiUrl: string,
	expectedCredential: StoredCredentialIdentity,
): Promise<MeResponse | null> {
	const endpointBinding = createCredentialEndpointBinding(apiUrl);
	const res = await fetch(`${endpointBinding.cloudApiOrigin}/v1/auth/me`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) return null;
	const me = await readJson<MeResponse>(res, "/v1/auth/me");
	await commitClawdiCredential(
		{ apiKey, userId: me.id, email: me.email, endpointBinding },
		expectedCredential,
	);
	return me;
}

function postLoginHint() {
	p.log.message(
		chalk.gray("Next: ") + chalk.bold("clawdi setup") + chalk.gray(" to register this machine."),
	);
	p.outro(chalk.gray("Credentials saved to ~/.clawdi/auth.json"));
}

async function authLoginManual(apiUrl: string, expectedCredential: StoredCredentialIdentity) {
	p.log.message(
		"To get an API key:\n" +
			chalk.gray("  1. Sign in at the Clawdi Cloud dashboard\n") +
			chalk.gray("  2. Open Settings → API Keys\n") +
			chalk.gray("  3. Create a new key and copy it"),
	);

	const apiKey = await p.password({
		message: "Paste your API key",
		validate: (v) => (v?.trim() ? undefined : "API key cannot be empty"),
	});
	if (p.isCancel(apiKey)) {
		p.cancel("Cancelled.");
		return;
	}

	const verifySpinner = p.spinner();
	verifySpinner.start("Verifying...");
	const trimmed = apiKey.trim();
	let me: MeResponse | null = null;
	try {
		me = await verifyAndSaveLegacy(trimmed, apiUrl, expectedCredential);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		verifySpinner.stop(chalk.red("Could not reach the API"));
		p.log.error(`Network error: ${msg}`);
		p.log.message(chalk.gray(`Current API URL: ${apiUrl}`));
		p.log.message(chalk.gray("If this is wrong, run `clawdi config unset apiUrl` and try again."));
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	if (!me) {
		verifySpinner.stop(chalk.red("Invalid API key"));
		p.log.message(chalk.gray("Double-check the key from Settings → API Keys in the dashboard."));
		p.log.message(chalk.gray(`Current API URL: ${apiUrl}`));
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	verifySpinner.stop(chalk.green(`Logged in as ${me.email || me.name || me.id}`));
	postLoginHint();
}

function isSshSession(): boolean {
	return Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

function pendingAuthExpired(pending: PendingAuth): boolean {
	const expiresAt = Date.parse(pending.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

async function startOAuthLogin(
	apiUrl: string,
	hostedApiUrl: string,
	expectedCredential: StoredCredentialIdentity,
): Promise<PendingAuth> {
	const endpointBinding = createCredentialEndpointBinding(apiUrl, hostedApiUrl);
	if (!endpointBinding.hostedApiOrigin) {
		throw new ClerkOAuthError(
			"invalid_credential_endpoint_binding",
			"Hosted endpoint binding is required for OAuth login.",
		);
	}
	const clientConfig = await fetchClerkOAuthClientConfig(endpointBinding.cloudApiOrigin);
	const discovery = await fetchClerkOAuthDiscovery(clientConfig);
	const pending = createClerkOAuthAuthorization({
		config: clientConfig,
		discovery,
		apiUrl: endpointBinding.cloudApiOrigin,
		hostedApiUrl: endpointBinding.hostedApiOrigin,
	});
	await persistPendingClerkOAuthLogin(pending, expectedCredential);
	return pending;
}

async function readCallbackFromStdin(): Promise<string> {
	let input = "";
	for await (const chunk of process.stdin) {
		input += String(chunk);
		if (input.length > 16_384) {
			throw new ClerkOAuthError("invalid_oauth_callback", "OAuth callback input was too long.");
		}
	}
	return input.trim();
}

async function promptForCallbackUrl(): Promise<string | null> {
	if (!process.stdin.isTTY) {
		const callback = await readCallbackFromStdin();
		return callback || null;
	}
	const callback = await p.password({
		message: "Paste the complete loopback callback URL from your browser",
		validate: (value) => (value?.trim() ? undefined : "Callback URL cannot be empty"),
	});
	if (p.isCancel(callback)) return null;
	return callback.trim();
}

export async function finishOAuthLogin(
	pending: PendingAuth,
	callbackUrl: string,
	expectedCredential: StoredCredentialIdentity,
): Promise<boolean> {
	const spinner = p.spinner();
	spinner.start("Exchanging the authorization code...");
	let auth: ClerkOAuthAuth;
	try {
		auth = await exchangeClerkOAuthCode(pending, callbackUrl);
	} catch (error) {
		spinner.stop(chalk.red("Authorization failed."));
		if (
			error instanceof ClerkOAuthError &&
			!["invalid_oauth_callback", "oauth_network_error"].includes(error.code)
		) {
			await clearPendingClerkOAuthLogin(pending);
		}
		throw error;
	}

	let verification: Awaited<ReturnType<typeof verifyAndPersistClerkOAuthLogin>>;
	try {
		verification = await verifyAndPersistClerkOAuthLogin(pending.apiUrl, auth, {
			expectedCredential,
			pending,
		});
	} catch (error) {
		spinner.stop(chalk.red("Cloud rejected the OAuth session."));
		throw error;
	}
	if (verification.kind === "cloud_unverified") {
		spinner.stop(chalk.yellow("Logged in; Cloud profile verification is temporarily unavailable."));
		p.log.message(
			chalk.gray(
				"The Clerk grant is saved, but Cloud has not verified it. Run `clawdi auth status` and retry a Cloud command when service recovers.",
			),
		);
		postLoginHint();
		return true;
	}

	const me = verification.user;
	spinner.stop(chalk.green(`Logged in as ${me.email || me.name || me.id}`));
	postLoginHint();
	return true;
}

function reportOAuthError(error: unknown): void {
	if (error instanceof ClerkOAuthError) {
		p.log.error(error.message);
	} else {
		p.log.error("Could not complete Clawdi OAuth login. Check your connection and retry.");
	}
	p.log.message(
		chalk.gray("Legacy compatibility remains available with: ") +
			chalk.bold("clawdi auth login --manual"),
	);
	process.exitCode = 1;
}

async function waitForLoopbackCallback(
	pending: PendingAuth,
	callbackUrl: Promise<string>,
): Promise<string> {
	const remainingMs = Math.max(1, Date.parse(pending.expiresAt) - Date.now());
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			callbackUrl,
			new Promise<string>((_resolve, reject) => {
				timeout = setTimeout(
					() =>
						reject(
							new ClerkOAuthError(
								"oauth_login_expired",
								"OAuth login expired. Run `clawdi auth login` again.",
							),
						),
					remainingMs,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export async function authLogin(opts: { manual?: boolean; open?: boolean } = {}) {
	const existing = getAuth();
	if (existing) {
		p.log.warn(`Already logged in as ${existing.email || existing.userId || "unknown"}`);
		p.log.info("Run `clawdi auth logout` first to switch accounts.");
		return;
	}

	if (opts.manual && (!process.stdout.isTTY || !process.stdin.isTTY)) {
		p.log.error("`clawdi auth login --manual` needs an interactive terminal.");
		p.log.message(
			chalk.gray("Run the command in a TTY, or use the default PKCE flow without --manual."),
		);
		process.exitCode = 1;
		return;
	}

	const config = getConfig();
	const expectedCredential = captureStoredCredentialIdentity();

	p.intro(chalk.bold("clawdi auth login"));

	if (opts.manual) {
		await authLoginManual(config.apiUrl, expectedCredential);
		return;
	}

	let pending: PendingAuth;
	try {
		pending = await startOAuthLogin(config.apiUrl, config.deployApiUrl, expectedCredential);
	} catch (error) {
		reportOAuthError(error);
		return;
	}
	p.log.message(
		"Authorize Clawdi in your browser:\n" +
			chalk.gray("URL: ") +
			chalk.underline(pending.authorizationUrl),
	);

	const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
	const useLoopback = interactive && opts.open !== false && !isSshSession();
	if (useLoopback) {
		let loopback: Awaited<ReturnType<typeof startClerkOAuthLoopback>> | null = null;
		try {
			loopback = await startClerkOAuthLoopback(pending.redirectUri, pending.state);
			openInBrowser(pending.authorizationUrl);
			const callbackUrl = await waitForLoopbackCallback(pending, loopback.callbackUrl);
			await finishOAuthLogin(pending, callbackUrl, expectedCredential);
			return;
		} catch (error) {
			if (error instanceof ClerkOAuthError) {
				if (error.code === "oauth_login_expired") {
					await clearPendingClerkOAuthLogin(pending);
				}
				reportOAuthError(error);
				return;
			}
			p.log.warn(
				"Could not bind the registered loopback callback. Paste the browser callback instead.",
			);
			openInBrowser(pending.authorizationUrl);
		} finally {
			await loopback?.close();
		}
	}

	if (!interactive) {
		p.log.message(
			chalk.gray(
				"After browser authorization, run `clawdi auth complete` and provide the complete failed loopback callback URL on stdin, never as an argument.",
			),
		);
		p.outro(chalk.gray("PKCE authorization state saved securely."));
		return;
	}

	if (isSshSession()) {
		p.log.message(
			chalk.gray(
				"SSH mode: open the URL on your local computer. The remote CLI cannot receive a local browser loopback callback.",
			),
		);
	}
	try {
		const callbackUrl = await promptForCallbackUrl();
		if (!callbackUrl) {
			p.cancel("Authorization remains pending; run `clawdi auth complete` to resume.");
			return;
		}
		await finishOAuthLogin(pending, callbackUrl, expectedCredential);
	} catch (error) {
		reportOAuthError(error);
	}
}

export async function authComplete() {
	if (isLoggedIn()) {
		const existing = getAuth();
		p.log.info(`Already logged in as ${existing?.email || existing?.userId || "unknown"}.`);
		return;
	}

	const pending = getPendingAuth();
	if (!pending) {
		p.log.error("No pending authorization. Run `clawdi auth login` first.");
		process.exitCode = 1;
		return;
	}

	if (pending.authType !== "clerk_oauth_pkce" || pendingAuthExpired(pending)) {
		p.log.error("Pending authorization has expired.");
		p.log.message(chalk.gray("Run `clawdi auth login` again to start a new one."));
		await clearPendingClerkOAuthLogin(pending);
		process.exitCode = 1;
		return;
	}

	p.intro(chalk.bold("clawdi auth complete"));
	p.log.message(
		chalk.gray("The callback contains a short-lived authorization code and will not be echoed."),
	);
	try {
		const callbackUrl = await promptForCallbackUrl();
		if (!callbackUrl) {
			p.cancel("Cancelled.");
			return;
		}
		await finishOAuthLogin(pending, callbackUrl, { kind: "none" });
	} catch (error) {
		reportOAuthError(error);
	}
}

export async function authStartMachine(): Promise<void> {
	const existing = getAuth();
	if (existing) {
		console.log(
			JSON.stringify({
				schemaVersion: "clawdi.authStart.v1",
				status: "already_authenticated",
				user: { id: existing.userId, ...(existing.email ? { email: existing.email } : {}) },
			}),
		);
		return;
	}

	const config = getConfig();
	const pending = await startOAuthLogin(
		config.apiUrl,
		config.deployApiUrl,
		captureStoredCredentialIdentity(),
	);
	console.log(
		JSON.stringify({
			schemaVersion: "clawdi.authStart.v1",
			status: "pending",
			authorizationUrl: pending.authorizationUrl,
			redirectUri: pending.redirectUri,
			expiresAt: pending.expiresAt,
		}),
	);
}

export async function authFinishMachine(): Promise<void> {
	const existing = getAuth();
	if (existing) {
		console.log(
			JSON.stringify({
				schemaVersion: "clawdi.authFinish.v1",
				status: "already_authenticated",
				user: { id: existing.userId, ...(existing.email ? { email: existing.email } : {}) },
			}),
		);
		return;
	}

	const pending = getPendingAuth();
	if (pending?.authType !== "clerk_oauth_pkce") {
		throw new Error("No pending authorization. Start sign-in again.");
	}
	if (pendingAuthExpired(pending)) {
		await clearPendingClerkOAuthLogin(pending);
		throw new Error("Authorization expired. Start sign-in again.");
	}
	const callbackUrl = await readCallbackFromStdin();
	if (!callbackUrl) throw new Error("The authorization callback was empty.");
	const auth = await exchangeClerkOAuthCode(pending, callbackUrl);
	const verification = await verifyAndPersistClerkOAuthLogin(pending.apiUrl, auth, {
		expectedCredential: { kind: "none" },
		pending,
	});
	console.log(
		JSON.stringify({
			schemaVersion: "clawdi.authFinish.v1",
			status: "authenticated",
			cloudVerified: verification.kind === "verified",
			...(verification.kind === "verified" ? { user: verification.user } : {}),
		}),
	);
}

export async function authDesktopSessionMachine(): Promise<void> {
	const auth = getAuth();
	if (!isClerkOAuthAuth(auth)) {
		throw new Error("Desktop sign-in requires Clerk OAuth. Sign in again from Clawdi Desktop.");
	}

	const payload = unwrap(await new ApiClient().POST("/v1/cli/auth/oauth/desktop-ticket"));

	console.log(
		JSON.stringify({
			schemaVersion: "clawdi.desktopSession.v1",
			ticket: payload.ticket,
			expiresIn: payload.expires_in,
		}),
	);
}

export async function authLogout() {
	if (!isLoggedIn()) {
		p.log.info("Not logged in.");
		return;
	}

	// Warn about running daemons before clearing creds. `clearAuth`
	// deletes auth.json + ~/.clawdi/environments/*, but launchd /
	// systemd units installed by `clawdi daemon install` keep
	// running with the API key cached in their unit env. They'll
	// keep posting heartbeats to the cloud (with a now-revoked
	// token, getting 401s in a tight loop) until the user
	// `daemon uninstall`s.
	//
	// Source from `listInstalledAgents` (scans the OS supervisor)
	// not `listRegisteredAgentTypes` (env-file registry) — the
	// env-file path would skip a daemon whose env file got deleted
	// but whose plist was still installed (codex flagged this gap
	// in PR-#74 review).
	const { listInstalledDaemonTargets } = await import("../serve/installer");
	const installedAgents = listInstalledDaemonTargets();
	if (installedAgents.length > 0) {
		p.log.warn(
			`${installedAgents.length} daemon(s) still installed (${installedAgents.join(", ")}). ` +
				`These keep running after logout and will fail with 401 against the cloud. ` +
				`Run \`clawdi daemon uninstall\` first, or accept the noise.`,
		);
	}

	const result = await logoutClawdiCredentials(getConfig().apiUrl);
	if (result.environmentCredential) {
		p.log.warn(
			"CLAWDI_AUTH_TOKEN controls this process. Unset it in the environment to log out; persisted credentials were not changed.",
		);
		return;
	}
	if (result.remoteRevoked) p.log.success("Remote Clerk OAuth grant revoked.");
	else if (result.loggedOut) {
		p.log.warn(
			"The local credential was removed. If remote OAuth revocation was unavailable, revoke the Clawdi OAuth application in your Clerk account if needed.",
		);
	}
	p.log.success("Logged out. Credentials and cached environments removed.");
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

	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify(payload, null, 2));
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
