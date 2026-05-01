import { spawn } from "node:child_process";
import { hostname } from "node:os";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import {
	clearAuth,
	clearPendingAuth,
	getAuth,
	getConfig,
	getPendingAuth,
	isLoggedIn,
	type PendingAuth,
	setAuth,
	setPendingAuth,
} from "../lib/config";

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
function openInBrowser(url: string): void {
	const cmd =
		process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	try {
		const args = process.platform === "win32" ? ["", url] : [url];
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			/* opener missing — user copies URL manually */
		});
		child.unref();
	} catch {
		/* same as above; tolerated */
	}
}

async function verifyAndSave(apiKey: string, apiUrl: string): Promise<MeResponse | null> {
	const res = await fetch(`${apiUrl}/api/auth/me`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) return null;
	const me = (await res.json()) as MeResponse;
	setAuth({ apiKey, userId: me.id, email: me.email });
	return me;
}

/**
 * Persist `apiKey` BEFORE doing anything that could fail. Used by the device
 * flow because by the time /poll returns the raw key, it's been consumed
 * server-side — if /me crashes a millisecond later, throwing away the key
 * leaves it active in the api_keys table with no way for the user to
 * recover it. Stash it on disk first; verification just enriches the
 * stored record with email/userId.
 */
async function saveThenVerify(apiKey: string, apiUrl: string): Promise<MeResponse | null> {
	setAuth({ apiKey });
	const res = await fetch(`${apiUrl}/api/auth/me`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) return null;
	const me = (await res.json()) as MeResponse;
	setAuth({ apiKey, userId: me.id, email: me.email });
	return me;
}

function postLoginHint() {
	p.log.message(
		chalk.gray("Next: ") + chalk.bold("clawdi setup") + chalk.gray(" to register this machine."),
	);
	p.outro(chalk.gray("Credentials saved to ~/.clawdi/auth.json"));
}

async function authLoginManual(apiUrl: string) {
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
		me = await verifyAndSave(trimmed, apiUrl);
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

interface DeviceStart {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

/**
 * Start the device flow: request a device_code from the server, persist it
 * to `~/.clawdi/pending-auth.json`, print the verification URL + user_code,
 * and try to open the browser. Does NOT poll — that's the caller's job
 * (via `pollUntilApproved`). Returns the pending state on success, null
 * on failure (after printing diagnostics).
 *
 * Splitting start from poll lets non-interactive callers (CI, AI agents
 * whose Bash tool blocks until the process exits) finish `auth login` in
 * milliseconds, surface the URL/code to the user, and resume via
 * `auth complete` — without holding a 10-minute polling loop open.
 */
async function startDeviceFlow(apiUrl: string): Promise<PendingAuth | null> {
	// `requireAuth: false` is essential — we're in the bootstrap path where
	// no api_key exists yet. The /device + /poll endpoints don't take auth.
	const api = new ApiClient({ requireAuth: false });
	const clientLabel = `clawdi cli · ${hostname()}`;

	let start: DeviceStart;
	try {
		start = unwrap(
			await api.POST("/api/cli/auth/device", {
				body: { client_label: clientLabel },
			}),
		);
	} catch (e) {
		if (e instanceof ApiError && (e.isNetwork || e.status === 0)) {
			p.log.error("Could not reach the Clawdi Cloud API.");
			p.log.message(chalk.gray(`Current API URL: ${apiUrl}`));
			p.log.message(
				chalk.gray("If this is wrong, run `clawdi config unset apiUrl` and try again."),
			);
		} else {
			const msg = e instanceof Error ? e.message : String(e);
			p.log.error(`Failed to start authorization: ${msg}`);
		}
		p.log.message(
			chalk.gray("Or skip the browser flow with: ") + chalk.bold("clawdi auth login --manual"),
		);
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return null;
	}

	const pending: PendingAuth = {
		deviceCode: start.device_code,
		userCode: start.user_code,
		verificationUri: start.verification_uri,
		expiresAt: Math.floor(Date.now() / 1000) + start.expires_in,
		intervalMs: Math.max(1, start.interval) * 1000,
		apiUrl,
	};
	setPendingAuth(pending);

	p.log.message(
		`Opening your browser to authorize this machine...\n` +
			chalk.gray("URL:  ") +
			chalk.underline(start.verification_uri) +
			"\n" +
			chalk.gray("Code: ") +
			chalk.bold(start.user_code) +
			chalk.gray("  (verify this matches what the page shows)"),
	);
	openInBrowser(start.verification_uri);

	return pending;
}

/**
 * Poll the server until the device authorization is approved, denied, or
 * the wait window elapses. Used by both the inline (TTY) login path and
 * the resumable `auth complete` command. Sets process.exitCode on failure
 * and returns true iff the user is now authenticated.
 *
 * `maxWaitMs` caps how long we'll poll *this invocation* — independent of
 * the server-side device TTL. Short waits are critical in non-TTY mode
 * (agent calling complete prematurely shouldn't hang the agent for 10
 * minutes); the device_code stays valid server-side, so the user can
 * approve and re-run `complete` to resume.
 */
async function pollUntilApproved(
	pending: PendingAuth,
	opts: { maxWaitMs?: number } = {},
): Promise<boolean> {
	const api = new ApiClient({ requireAuth: false });
	const spinner = p.spinner();
	spinner.start("Waiting for you to authorize in the browser...");

	const serverDeadline = pending.expiresAt * 1000;
	const deadline = opts.maxWaitMs
		? Math.min(serverDeadline, Date.now() + opts.maxWaitMs)
		: serverDeadline;
	const hitClientCap = () => deadline < serverDeadline;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, pending.intervalMs));

		let poll: { status: string; api_key?: string | null };
		try {
			poll = unwrap(
				await api.POST("/api/cli/auth/poll", {
					body: { device_code: pending.deviceCode },
				}),
			);
		} catch (e) {
			// Transient errors during polling shouldn't kill the flow — the user
			// might be on flaky wifi. Keep waiting until the deadline.
			if (e instanceof ApiError && e.isNetwork) continue;
			spinner.stop(chalk.red("Polling failed."));
			throw e;
		}

		if (poll.status === "pending") continue;

		if (poll.status === "approved" && poll.api_key) {
			spinner.stop(chalk.green("Authorized."));
			const verify = p.spinner();
			verify.start("Verifying...");
			// Use saveThenVerify, not verifyAndSave: the api_key has just been
			// consumed server-side and we cannot fetch it again. If /me errors,
			// the key is still valid — keep it on disk so the user isn't
			// silently locked out.
			const me = await saveThenVerify(poll.api_key, pending.apiUrl);
			clearPendingAuth();
			if (!me) {
				verify.stop(chalk.yellow("Key saved, but /me check failed."));
				p.log.message(chalk.gray("Run `clawdi status` once your network is healthy to confirm."));
				p.outro(chalk.gray("Credentials saved to ~/.clawdi/auth.json"));
				return true;
			}
			verify.stop(chalk.green(`Logged in as ${me.email || me.name || me.id}`));
			postLoginHint();
			return true;
		}

		if (poll.status === "denied") {
			spinner.stop(chalk.red("Authorization denied in the browser."));
			clearPendingAuth();
			p.outro(chalk.red("Aborted."));
			process.exitCode = 1;
			return false;
		}

		// "expired" or any unknown status — bail out (server-side terminal).
		spinner.stop(chalk.yellow("Authorization expired."));
		clearPendingAuth();
		p.log.message(chalk.gray("Run `clawdi auth login` again to retry."));
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return false;
	}

	// Loop exited via deadline. If we hit the *client* cap, the device_code
	// is still valid server-side — preserve pending so the user can re-run
	// `clawdi auth complete` after they finish approving.
	if (hitClientCap()) {
		const minutesLeft = Math.max(1, Math.ceil((serverDeadline - Date.now()) / 60_000));
		spinner.stop(chalk.yellow("Still waiting for approval."));
		p.log.message(
			chalk.gray(
				`After approving in your browser, run: ${chalk.bold("clawdi auth complete")}\n` +
					`The pending authorization stays valid for about ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}.`,
			),
		);
		p.outro(chalk.gray("Not yet approved."));
		process.exitCode = 2; // distinct from generic failure (1)
		return false;
	}

	spinner.stop(chalk.yellow("Timed out waiting for authorization."));
	clearPendingAuth();
	p.log.message(chalk.gray("Run `clawdi auth login` again to retry."));
	p.outro(chalk.red("Aborted."));
	process.exitCode = 1;
	return false;
}

export async function authLogin(opts: { manual?: boolean } = {}) {
	const existing = getAuth();
	if (existing) {
		p.log.warn(`Already logged in as ${existing.email || existing.userId || "unknown"}`);
		p.log.info("Run `clawdi auth logout` first to switch accounts.");
		return;
	}

	// Manual flow uses an interactive password prompt and genuinely cannot
	// run without a TTY. Device flow, by contrast, just prints a URL + code
	// and (in non-TTY mode) exits immediately for the agent to relay.
	if (opts.manual && (!process.stdout.isTTY || !process.stdin.isTTY)) {
		p.log.error("`clawdi auth login --manual` needs an interactive terminal.");
		p.log.message(
			chalk.gray(
				"Drop --manual to use the device flow (works non-interactively),\n" +
					"or write your API key directly to `~/.clawdi/auth.json`:\n" +
					'  { "apiKey": "clawdi_…" }',
			),
		);
		process.exitCode = 1;
		return;
	}

	const config = getConfig();

	p.intro(chalk.bold("clawdi auth login"));

	if (opts.manual) {
		await authLoginManual(config.apiUrl);
		return;
	}

	const pending = await startDeviceFlow(config.apiUrl);
	if (!pending) return; // diagnostics already printed by startDeviceFlow

	// Interactive humans get the one-shot experience: stay open and poll
	// until they finish in the browser. Non-interactive callers (CI, AI
	// agents) get a fast exit so they can surface the URL/code to a human;
	// that human resumes via `clawdi auth complete`.
	const interactive = process.stdout.isTTY && process.stdin.isTTY;
	if (interactive) {
		await pollUntilApproved(pending);
		return;
	}

	p.log.message(
		chalk.gray("After approving in your browser, run: ") + chalk.bold("clawdi auth complete"),
	);
	p.outro(chalk.gray("Authorization started. Waiting for browser approval."));
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

	if (Date.now() / 1000 >= pending.expiresAt) {
		p.log.error("Pending authorization has expired.");
		p.log.message(chalk.gray("Run `clawdi auth login` again to start a new one."));
		clearPendingAuth();
		process.exitCode = 1;
		return;
	}

	p.intro(chalk.bold("clawdi auth complete"));
	p.log.message(chalk.gray("Resuming authorization for code: ") + chalk.bold(pending.userCode));

	// In non-TTY mode, cap the wait so an over-eager agent (running
	// `complete` before the user has actually approved) doesn't hang for
	// the full 10-minute server TTL. The pending state survives a short
	// timeout, so the agent can simply re-run `complete` after confirming.
	const interactive = process.stdout.isTTY && process.stdin.isTTY;
	const maxWaitMs = interactive ? undefined : 30_000;
	await pollUntilApproved(pending, { maxWaitMs });
}

export async function authLogout() {
	if (!isLoggedIn()) {
		p.log.info("Not logged in.");
		return;
	}

	// Warn about running daemons before clearing creds. `clearAuth`
	// deletes auth.json + ~/.clawdi/environments/*, but launchd /
	// systemd units installed by `clawdi serve install` keep
	// running with the API key cached in their unit env. They'll
	// keep posting heartbeats to the cloud (with a now-revoked
	// token, getting 401s in a tight loop) until the user
	// `serve uninstall`s.
	//
	// Source from `listInstalledAgents` (scans the OS supervisor)
	// not `listRegisteredAgentTypes` (env-file registry) — the
	// env-file path would skip a daemon whose env file got deleted
	// but whose plist was still installed (codex flagged this gap
	// in PR-#74 review).
	const { listInstalledAgents } = await import("../serve/installer");
	const installedAgents = listInstalledAgents();
	if (installedAgents.length > 0) {
		p.log.warn(
			`${installedAgents.length} daemon(s) still installed (${installedAgents.join(", ")}). ` +
				`These keep running after logout and will fail with 401 against the cloud. ` +
				`Run \`clawdi serve uninstall --all\` first, or accept the noise.`,
		);
	}

	clearAuth();
	p.log.success("Logged out. Credentials and cached environments removed.");
}
