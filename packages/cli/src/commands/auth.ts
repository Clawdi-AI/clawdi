import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import type { components } from "@clawdi/shared/api";
import chalk from "chalk";
import { readJson } from "../lib/api-client";
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
	getClawdiAccessToken,
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
import type { ShareToken } from "../share/tokens";

export { browserOpenCommand } from "../lib/browser";

function upgradeIdempotencyKey(token: string): string {
	return `upgrade-${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
}

interface MeResponse {
	id: string;
	email: string;
	name: string;
}

type ShareUpgradeResponse = components["schemas"]["ShareUpgradeResponse"];

function shareDisplayName(token: ShareToken): string {
	const name = typeof token.project_name === "string" ? token.project_name.trim() : "";
	if (name) return name;
	const projectId = typeof token.project_id === "string" ? token.project_id.trim() : "";
	return projectId ? `Project ${projectId}` : "local share";
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

/**
 * Scan ~/.clawdi/share-tokens.json for un-upgraded entries and POST
 * /upgrade for each. Synchronous + reported: blocks `auth login`
 * until done so a subsequent `clawdi project list` shows the new
 * project memberships deterministically.
 *
 * Per-token failures don't abort the loop. Local entries stay available
 * for retry or explicit `clawdi inbox forget` cleanup because the file
 * does not record which API origin issued a token, so even a 404 from the
 * current API cannot prove that the credential is globally stale.
 */
async function autoUpgradePendingShares(apiUrl: string, apiKey: string): Promise<void> {
	const { readTokenStore, addToken } = await import("../share/tokens");
	const store = readTokenStore();
	for (const issue of store.issues) {
		p.log.warn(
			`Skipped malformed local share "${issue.label}": ${issue.reason} (entry kept for recovery)`,
		);
	}
	const tokens = store.tokens.filter((t) => !t.upgraded_at);
	if (tokens.length === 0) return;

	// Parallel network round-trips, sequential disk writes. addToken
	// is load-modify-save unlocked, so two concurrent calls can race
	// and silently drop one upsert; keeping the disk writes inside
	// a serial loop avoids that without holding 5 round-trips in
	// series for a user with 5 pending shares.
	type Outcome =
		| { kind: "ok"; token: ShareToken; alias?: string; projectId: string; ownerHandle: string }
		| { kind: "already_owner"; token: ShareToken }
		| { kind: "fail"; name: string; reason: string };

	const outcomes = await Promise.all(
		tokens.map(async (t): Promise<Outcome> => {
			const name = shareDisplayName(t);
			try {
				const r = await fetch(`${apiUrl}/v1/share/${encodeURIComponent(t.token)}/upgrade`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						"Idempotency-Key": upgradeIdempotencyKey(t.token),
					},
					body: "{}",
				});
				if (r.status === 404) {
					return {
						kind: "fail",
						name,
						reason: "share link not found on this API (local token kept)",
					};
				}
				if (r.status === 410) {
					return {
						kind: "fail",
						name,
						reason: "share link was revoked, expired, or removed (local token kept)",
					};
				}
				if (r.status === 409) {
					const body = (await r.json().catch(() => ({}))) as {
						detail?: { error?: string };
					};
					if (body?.detail?.error === "mount_target_ambiguous") {
						return {
							kind: "fail",
							name,
							reason: "needs manual project review",
						};
					}
					if (body?.detail?.error === "already_owner") {
						return { kind: "already_owner", token: t };
					}
					return {
						kind: "fail",
						name,
						reason: body.detail?.error ? `conflict: ${body.detail.error}` : "HTTP 409 conflict",
					};
				}
				if (!r.ok) {
					return { kind: "fail", name, reason: `HTTP ${r.status}` };
				}
				const body = await readJson<ShareUpgradeResponse>(r, "share upgrade");
				if (
					typeof body.project_id !== "string" ||
					!body.project_id.trim() ||
					typeof body.resolved_owner_handle !== "string" ||
					!body.resolved_owner_handle.trim()
				) {
					throw new Error("share upgrade returned an invalid response");
				}
				return {
					kind: "ok",
					token: t,
					projectId: body.project_id,
					ownerHandle: body.resolved_owner_handle,
				};
			} catch (e) {
				return {
					kind: "fail",
					name,
					reason: e instanceof Error ? e.message : "network error",
				};
			}
		}),
	);

	const { pullSharedSkills } = await import("../share/eager-pull");
	const results: Array<{ name: string; alias?: string; pulled?: number; reason?: string }> = [];
	for (const o of outcomes) {
		if (o.kind === "ok") {
			addToken({
				...o.token,
				project_id: o.projectId,
				owner_handle: o.ownerHandle,
				upgraded_at: new Date().toISOString(),
			});
			const pulled = await pullSharedSkills(apiUrl, apiKey, o.projectId, o.ownerHandle).catch(
				() => 0,
			);
			results.push({ name: shareDisplayName(o.token), alias: o.alias, pulled });
		} else if (o.kind === "already_owner") {
			addToken({ ...o.token, upgraded_at: new Date().toISOString() });
		} else {
			results.push({ name: o.name, reason: o.reason });
		}
	}

	const ok = results.filter((r) => !r.reason);
	const fail = results.filter((r) => r.reason);
	if (ok.length > 0) {
		p.log.success(`Auto-upgraded ${ok.length} pending share${ok.length === 1 ? "" : "s"}:`);
		for (const o of ok) {
			const pulled =
				o.pulled && o.pulled > 0
					? chalk.gray(` · pulled ${o.pulled} skill${o.pulled === 1 ? "" : "s"}`)
					: "";
			p.log.message(
				chalk.gray(`  → `) + chalk.bold(o.alias ?? o.name) + chalk.gray(` ready`) + pulled,
			);
		}
	}
	for (const f of fail) {
		p.log.warn(`Could not upgrade "${f.name}": ${f.reason}`);
	}
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
	await autoUpgradePendingShares(apiUrl, apiKey);
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
	await autoUpgradePendingShares(pending.apiUrl, auth.apiKey);
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
		const { apiUrl } = getConfig();
		try {
			await autoUpgradePendingShares(apiUrl, await getClawdiAccessToken(apiUrl));
		} catch (error) {
			reportOAuthError(error);
		}
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

type AuthStatusSource = "auth.json" | "CLAWDI_AUTH_TOKEN" | "runtime-instance-data" | "none";

function detectAuthSource(): AuthStatusSource {
	const paths = getRuntimePaths();
	if (process.env.CLAWDI_AUTH_TOKEN) return "CLAWDI_AUTH_TOKEN";
	if (existsSync(paths.localAuth)) return "auth.json";
	if (existsSync(paths.sensitiveInstanceData)) return "runtime-instance-data";
	return "none";
}

export async function authStatus(opts: { json?: boolean } = {}) {
	const auth = getAuth();
	const config = getConfig();
	const mode = detectRuntimeMode();
	const paths = getRuntimePaths({ mode });
	const source = detectAuthSource();
	const authenticated = Boolean(auth) || source === "runtime-instance-data";
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
			managedConfig: mode === "hosted" ? paths.managedConfig : undefined,
			sensitiveInstanceDataPresent: existsSync(paths.sensitiveInstanceData),
			sensitiveInstanceData: "<redacted>",
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
