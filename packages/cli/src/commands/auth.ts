import { spawn } from "node:child_process";
import { hostname } from "node:os";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { clearAuth, getAuth, getConfig, isLoggedIn, setAuth } from "../lib/config";

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

async function authLoginDeviceFlow(apiUrl: string) {
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
		return;
	}

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

	const spinner = p.spinner();
	spinner.start("Waiting for you to authorize in the browser...");

	const deadline = Date.now() + start.expires_in * 1000;
	const intervalMs = Math.max(1, start.interval) * 1000;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, intervalMs));

		let poll: { status: string; api_key?: string | null };
		try {
			poll = unwrap(
				await api.POST("/api/cli/auth/poll", {
					body: { device_code: start.device_code },
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
			const me = await saveThenVerify(poll.api_key, apiUrl);
			if (!me) {
				verify.stop(chalk.yellow("Key saved, but /me check failed."));
				p.log.message(chalk.gray("Run `clawdi status` once your network is healthy to confirm."));
				p.outro(chalk.gray("Credentials saved to ~/.clawdi/auth.json"));
				return;
			}
			verify.stop(chalk.green(`Logged in as ${me.email || me.name || me.id}`));
			postLoginHint();
			return;
		}

		if (poll.status === "denied") {
			spinner.stop(chalk.red("Authorization denied in the browser."));
			p.outro(chalk.red("Aborted."));
			process.exitCode = 1;
			return;
		}

		// "expired" or any unknown status — bail out.
		spinner.stop(chalk.yellow("Authorization expired."));
		p.log.message(chalk.gray("Run `clawdi auth login` again to retry."));
		p.outro(chalk.red("Aborted."));
		process.exitCode = 1;
		return;
	}

	spinner.stop(chalk.yellow("Timed out waiting for authorization."));
	p.log.message(chalk.gray("Run `clawdi auth login` again to retry."));
	p.outro(chalk.red("Aborted."));
	process.exitCode = 1;
}

export async function authLogin(opts: { manual?: boolean } = {}) {
	const existing = getAuth();
	if (existing) {
		p.log.warn(`Already logged in as ${existing.email || existing.userId || "unknown"}`);
		p.log.info("Run `clawdi auth logout` first to switch accounts.");
		return;
	}

	// Both paths below need a TTY: device flow opens a browser and shows a
	// code, manual flow uses an interactive password prompt. Bail out early
	// in CI/SSH-without-pty/piped-stdout — the alternative is a 10-minute
	// silent poll-timeout (device) or a hung password prompt (manual).
	// Headless installs should pre-populate `~/.clawdi/auth.json` directly.
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		p.log.error("`clawdi auth login` needs an interactive terminal.");
		p.log.message(
			chalk.gray(
				"Headless setup: write your API key directly to `~/.clawdi/auth.json`:\n" +
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

	await authLoginDeviceFlow(config.apiUrl);
}

export async function authLogout() {
	if (!isLoggedIn()) {
		p.log.info("Not logged in.");
		return;
	}

	clearAuth();
	p.log.success("Logged out. Credentials and cached environments removed.");
}
