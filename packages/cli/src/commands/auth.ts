import { accessSync, constants, existsSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient, ApiError, readJson, unwrap } from "../lib/api-client";
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
import { getAuth, getConfig, getPendingAuth, isLoggedIn, type PendingAuth } from "../lib/config";
import { detectRuntimeMode, getRuntimePaths } from "../runtime/paths";

export { browserOpenCommand } from "../lib/browser";

interface MeResponse {
	id: string;
	email: string;
	name: string;
}

async function verifyAndSaveLegacy(
	apiKey: string,
	apiUrl: string,
	expectedCredential: StoredCredentialIdentity,
): Promise<MeResponse | null> {
	const endpointBinding = createCredentialEndpointBinding(apiUrl);
	const res = await fetch(`${endpointBinding.cloudApiOrigin}/v1/auth/me`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (res.status === 401) {
		throw new ApiError({
			status: res.status,
			body: await res.text(),
			hint: "Double-check the key from Settings → API Keys in the dashboard.",
		});
	}
	if (!res.ok) return null;
	const me = await readJson<MeResponse>(res, "/v1/auth/me");
	await commitClawdiCredential(
		{ apiKey, userId: me.id, email: me.email, endpointBinding },
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
		"For servers and automation, create a scoped, expiring API key:\n" +
			chalk.gray("  1. Sign in at the Clawdi dashboard\n") +
			chalk.gray("  2. Open Settings → API Keys\n") +
			chalk.gray("  3. Select the required scopes and expiry, then create and copy the key\n") +
			chalk.gray("On your own computer, use `clawdi auth login` instead."),
		{ output: process.stderr },
	);

	const apiKey = await p.password({
		output: process.stderr,
		message: "Paste your API key",
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
			verifySpinner.stop(chalk.red("Invalid API key"));
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
		p.log.message(chalk.gray("Double-check the key from Settings → API Keys in the dashboard."), {
			output: process.stderr,
		});
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
): Promise<PendingAuth> {
	const endpointBinding = createCredentialEndpointBinding(apiUrl, hostedApiUrl);
	if (!endpointBinding.hostedApiOrigin) {
		throw new ClerkOAuthError(
			"invalid_credential_endpoint_binding",
			"OAuth sign-in requires a CLAWDI_DEPLOY_API_URL binding.",
		);
	}
	const clientConfig = await fetchClerkOAuthClientConfig(endpointBinding.cloudApiOrigin);
	const discovery = await fetchClerkOAuthDiscovery(clientConfig);
	const pending = await startClerkDeviceAuthorization({
		config: clientConfig,
		discovery,
		apiUrl: endpointBinding.cloudApiOrigin,
		hostedApiUrl: endpointBinding.hostedApiOrigin,
	});
	await persistPendingClerkOAuthLogin(pending, expectedCredential);
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
	ui: { open: boolean; quiet: boolean; progress?: (pending: PendingAuth) => void },
): Promise<void> {
	if (!ui.quiet) printDeviceInstructions(pending);
	ui.progress?.(pending);
	if (ui.open) openInBrowser(pending.verificationUriComplete ?? pending.verificationUri);
	let auth: Awaited<ReturnType<typeof pollClerkDeviceToken>>;
	try {
		auth = await pollClerkDeviceToken(pending, { onSlowDown: persistClerkDeviceSlowDown });
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
			current.subject === auth.subject
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
		if (pending.authType === "clerk_oauth_pkce") {
			await clearPendingClerkOAuthLogin(pending);
			throw new ClerkOAuthError(
				"legacy_pending_auth",
				"This sign-in was started by an older Clawdi CLI. Run `clawdi auth login` again.",
			);
		}
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
		const pending = await startOAuthLogin(config.apiUrl, config.deployApiUrl, expected);
		await runDeviceLogin(pending, expected, {
			open: true,
			quiet: true,
			progress: (pending) =>
				console.error(
					JSON.stringify({
						schemaVersion: "clawdi.desktopLogin.progress.v1",
						verificationUri: pending.verificationUriComplete ?? pending.verificationUri,
						userCode: pending.userCode,
						expiresAt: pending.expiresAt,
					}),
				),
		});
	}
	const auth = getAuth();
	if (!isClerkOAuthAuth(auth)) throw new Error("Desktop sign-in did not save an OAuth session.");
	console.log(
		JSON.stringify({
			schemaVersion: "clawdi.desktopLogin.v1",
			status: "authenticated",
			user: { id: auth.userId, ...(auth.email ? { email: auth.email } : {}) },
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
		p.log.info("Not signed in.", { output: process.stderr });
		return;
	}

	// Warn about running daemons before clearing creds. `clearAuth`
	// deletes auth.json, but launchd / systemd units installed by
	// `clawdi daemon install` keep
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
