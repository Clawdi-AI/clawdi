/**
 * Install / start / stop `clawdi daemon` as a per-user OS
 * service.
 *
 * Two backends, one shape:
 *
 *   - macOS: ~/Library/LaunchAgents/ai.clawdi.serve.plist + launchctl
 *   - Linux: ~/.config/systemd/user/clawdi-serve.service + systemctl --user
 *
 * Per-user (not system-wide) on purpose:
 *   - the daemon reads ~/.clawdi/auth.json, which is per-user
 *   - keeping it user-scoped means no sudo, no risk of stomping
 *     on a different user's auth, and the unit dies cleanly when
 *     the user logs out (laptops where each session ssh's into
 *     a fresh shell)
 *
 * `clawdi daemon install` writes one singleton unit
 * (`ai.clawdi.serve` / `clawdi-serve.service`) whose process runs
 * every registered agent's sync engine.
 *
 * Windows: current-user InteractiveToken Task Scheduler task.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { persistAuthTokenFile } from "../lib/auth-token-file";
import {
	type CurrentCliInvocation,
	detectDesktopManagedNativeLayout,
	detectHomebrewManagedNativeLayout,
	resolveCurrentCliInvocation,
	resolveCurrentCliLayout,
} from "../lib/current-cli-invocation";
import {
	installWindowsTask,
	restartWindowsTask,
	stopWindowsTask,
	uninstallWindowsTask,
	windowsTaskInstalled,
	windowsTaskRunning,
	windowsTaskStatus,
} from "./windows-task";

interface InstallOpts {
	rpcHost?: string;
	rpcPort?: number;
	rpcAllowRemote?: boolean;
}

export class BackgroundServiceUnsupportedError extends Error {}

function launchdDomain(): string {
	const uid = process.getuid?.();
	if (uid === undefined)
		throw new BackgroundServiceUnsupportedError("no launchd user ID available");
	return `gui/${uid}`;
}

/** Check the manager before writing service files or persisting credentials.
 * show-environment also succeeds for a degraded systemd user manager, unlike
 * is-system-running. Its output is discarded because it may contain secrets. */
function requireBackgroundServiceManager(): void {
	const p = platform();
	if (p === "linux" && !tryRun(["systemctl", "--user", "show-environment"])) {
		throw new BackgroundServiceUnsupportedError("no systemd user manager available");
	}
	if (p === "darwin" && !tryRun(["launchctl", "print", launchdDomain()])) {
		throw new BackgroundServiceUnsupportedError("no launchd GUI user domain available");
	}
	if (p !== "linux" && p !== "darwin" && p !== "win32") {
		throw new BackgroundServiceUnsupportedError(`unsupported platform for service install: ${p}`);
	}
}

function home(): string {
	return process.env.HOME || homedir();
}

/** Root of the clawdi state tree (auth, environments, locks,
 * daemon queue, daemon logs). Honors `CLAWDI_HOME` so test harnesses
 * + the `clawdi-dev` wrapper get isolated state. Pre-fix
 * `installLaunchd`'s logDir hardcoded `$HOME/.clawdi`, so a
 * `CLAWDI_HOME=/foo clawdi daemon install` would bake
 * `$HOME/.clawdi/serve/logs/...` into the plist while `daemon logs`
 * (which DID honor CLAWDI_HOME via `getServeLogPath`) looked at
 * `/foo/serve/logs/...` — `daemon logs` couldn't find the file.
 * The installer and log command must resolve the same state root. */
function clawdiRoot(): string {
	const homeOverride = process.env.CLAWDI_HOME;
	if (homeOverride) return homeOverride;
	return join(home(), ".clawdi");
}

function unitName(): string {
	return "ai.clawdi.serve";
}

function daemonProgramArgs(authTokenFile?: string): string[] {
	const args = ["daemon", "run"];
	return authTokenFile ? [...args, "--auth-token-file", authTokenFile] : args;
}

/** CLAWDI_* env vars that need to be baked into the supervisor
 * unit so the daemon under launchd / systemd sees them after
 * reboot. Capturing these at install time matches "the daemon
 * runs the same way it ran when I installed it" — the user's
 * mental model. Without this, an env-only auth setup
 * (`CLAWDI_AUTH_TOKEN=… clawdi daemon install`) silently breaks
 * after the first reboot because the supervisor strips the
 * shell env and `~/.clawdi/auth.json` was never written.
 *
 * Whitelist deliberately narrow:
 *   - CLAWDI_AUTH_TOKEN_ORIGIN / CLAWDI_API_URL: auth + endpoint
 *   - CLAWDI_STATE_DIR: state dir override
 *   - CLAWDI_NO_AUTO_UPDATE: keep an embedding application in charge of updates
 *   - CLAWDI_DAEMON_RPC_HOST / CLAWDI_DAEMON_RPC_PORT /
 *     CLAWDI_DAEMON_RPC_ALLOW_REMOTE: HTTP listener settings for
 *     the owner-token-protected control RPC
 *   - CLAWDI_AGENT_TYPE: container fallback when no env registry exists
 *   - CLAWDI_SERVE_MODE: container/laptop mode
 *   - CLAWDI_SERVE_DEBUG: verbose log level
 *   - CLAUDE_CONFIG_DIR / CODEX_HOME / HERMES_HOME /
 *     OPENCLAW_STATE_DIR / OPENCLAW_AGENT_ID: per-adapter
 *     overrides (the daemon depends on these to find each
 *     agent's local data root)
 *
 * NOTE: `CLAWDI_ENVIRONMENT_ID` is deliberately NOT captured here.
 * It's per-agent state and lives in `~/.clawdi/environments/<agent>.json`
 * (written by `clawdi setup`). Capturing the shell env var would let a
 * single env id leak into the singleton daemon and be misapplied across
 * multiple engines.
 */
const PERSISTED_ENV_KEYS = [
	"CLAWDI_AUTH_TOKEN_ORIGIN",
	"CLAWDI_API_URL",
	"CLAWDI_STATE_DIR",
	"CLAWDI_NO_AUTO_UPDATE",
	"CLAWDI_DESKTOP_RUNTIME",
	"CLAWDI_DAEMON_RPC_HOST",
	"CLAWDI_DAEMON_RPC_PORT",
	"CLAWDI_DAEMON_RPC_ALLOW_REMOTE",
	// CLAWDI_HOME redirects the entire CLI state tree (auth.json,
	// environments, locks, serve queue/health) to a sibling
	// directory; honored by `lib/config.ts:clawdiDir()` and
	// `serve/paths.ts:getServeStateDir()`. Without persisting it
	// in the supervisor unit, an install run via
	// `CLAWDI_HOME=… clawdi daemon install` would foreground-work
	// but the supervised daemon would fall back to the real
	// `~/.clawdi/` after the user logs out — splitting state
	// across two directories and breaking the isolation guarantee.
	"CLAWDI_HOME",
	"CLAWDI_AGENT_TYPE",
	"CLAWDI_SERVE_MODE",
	"CLAWDI_SERVE_DEBUG",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"HERMES_HOME",
	"OPENCLAW_STATE_DIR",
	"OPENCLAW_AGENT_ID",
] as const;

function capturedEnv(
	opts: InstallOpts = {},
	desktopRuntime: { runtimeRoot?: string } | null = null,
	homebrewManaged = false,
): { key: string; value: string }[] {
	const out: { key: string; value: string }[] = [];
	for (const key of PERSISTED_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined && value !== "") {
			out.push({ key, value });
		}
	}
	upsertCapturedEnv(out, "CLAWDI_DAEMON_RPC_HOST", opts.rpcHost);
	upsertCapturedEnv(
		out,
		"CLAWDI_DAEMON_RPC_PORT",
		opts.rpcPort === undefined ? undefined : String(opts.rpcPort),
	);
	upsertCapturedEnv(
		out,
		"CLAWDI_DAEMON_RPC_ALLOW_REMOTE",
		opts.rpcAllowRemote === true ? "1" : undefined,
	);
	if (desktopRuntime || homebrewManaged) {
		upsertCapturedEnv(out, "CLAWDI_NO_AUTO_UPDATE", "1");
	}
	if (desktopRuntime) {
		upsertCapturedEnv(out, "CLAWDI_DESKTOP_RUNTIME", desktopRuntime.runtimeRoot);
	}
	return out;
}

function upsertCapturedEnv(
	out: { key: string; value: string }[],
	key: string,
	value?: string,
): void {
	if (value === undefined || value === "") return;
	const existing = out.find((item) => item.key === key);
	if (existing) {
		existing.value = value;
		return;
	}
	out.push({ key, value });
}

interface DaemonInstallContext {
	invocation: CurrentCliInvocation;
	environment: { key: string; value: string }[];
}

/** Resolve this exact CLI installation and its supervisor environment. */
function currentDaemonInstallContext(opts: InstallOpts): DaemonInstallContext {
	let invocation: CurrentCliInvocation;
	let desktopRuntime: ReturnType<typeof detectDesktopManagedNativeLayout> = null;
	let homebrewRuntime: ReturnType<typeof detectHomebrewManagedNativeLayout> = null;
	try {
		const layout = resolveCurrentCliLayout();
		desktopRuntime = detectDesktopManagedNativeLayout(layout, platform());
		homebrewRuntime = detectHomebrewManagedNativeLayout(layout, platform());
		if (
			layout.kind === "native" &&
			!layout.nativeOwnership &&
			!desktopRuntime &&
			!homebrewRuntime
		) {
			throw new Error(
				"an unowned native executable cannot install a daemon; install through Homebrew, the native distribution, or Clawdi Desktop",
			);
		}
		const authTokenFile = process.env.CLAWDI_AUTH_TOKEN
			? persistAuthTokenFile(clawdiRoot(), process.env.CLAWDI_AUTH_TOKEN)
			: undefined;
		invocation = resolveCurrentCliInvocation(daemonProgramArgs(authTokenFile));
		if (homebrewRuntime) invocation.command = homebrewRuntime.activationPath;
	} catch (error) {
		throw new Error(
			`could not resolve the current CLI for daemon installation: ${
				error instanceof Error ? error.message : String(error)
			}. Reinstall the CLI and try again.`,
		);
	}
	// Reject TypeScript source paths. A common dev-mode footgun:
	// running `bun run packages/cli/src/index.ts daemon install`
	// from a clone bakes the .ts source path into the launchd /
	// systemd unit. After reboot, the supervisor launches that
	// unit via the system `node` binary which can't execute raw
	// TypeScript — daemon crashes silently in a respawn loop and
	// the user has no idea what's wrong because `launchctl bootstrap`
	// itself succeeded. Fail loudly at install time instead.
	if (invocation.entryPath && /\.tsx?$/.test(invocation.entryPath)) {
		throw new Error(
			"refusing to install a daemon unit with a TypeScript source path " +
				`(entry=${invocation.entryPath}). The OS supervisor can't run .ts files. ` +
				"Build a JS bundle first (npm i -g clawdi or bun run build) " +
				"and re-run install from the installed binary.",
		);
	}
	return {
		invocation,
		environment: capturedEnv(opts, desktopRuntime, homebrewRuntime !== null),
	};
}

export function install(opts: InstallOpts = {}): {
	unit: string;
	instructions: string;
	replaced: boolean;
} {
	requireBackgroundServiceManager();
	const p = platform();
	if (p === "darwin") return installLaunchd(opts);
	if (p === "linux") return installSystemd(opts);
	if (p === "win32") {
		const context = currentDaemonInstallContext(opts);
		return installWindowsTask(clawdiRoot(), context.invocation, [
			{ key: "HOME", value: home() },
			...context.environment,
		]);
	}
	throw new Error(`unsupported platform for service install: ${p}`);
}

export function uninstall(): { removed: boolean } {
	const p = platform();
	if (p === "darwin") return uninstallLaunchd();
	if (p === "linux") return uninstallSystemd();
	if (p === "win32") return uninstallWindowsTask(clawdiRoot());
	throw new Error(`unsupported platform for service uninstall: ${p}`);
}

export function statusLines(): string[] {
	const p = platform();
	if (p === "darwin") return statusLaunchd();
	if (p === "linux") return statusSystemd();
	if (p === "win32") return windowsTaskStatus();
	return [`unsupported platform: ${p}`];
}

/** Restart an already-installed daemon unit. Throws if no unit is
 * installed (caller should install first) or if the supervisor
 * refuses to restart (corrupt unit, permissions, etc). */
export function restart(): void {
	const p = platform();
	if (p === "darwin") {
		restartLaunchd();
	} else if (p === "linux") {
		restartSystemd();
	} else if (p === "win32") {
		restartWindowsTask();
	} else {
		throw new Error(`unsupported platform for service restart: ${p}`);
	}
}

/** Stop an installed daemon without removing or disabling its supervisor unit. */
export function stop(): void {
	const p = platform();
	if (p === "darwin") {
		stopLaunchd();
	} else if (p === "linux") {
		stopSystemd();
	} else if (p === "win32") {
		stopWindowsTask();
	} else {
		throw new Error(`unsupported platform for service stop: ${p}`);
	}
}

function restartLaunchd(): void {
	const path = singletonPlistPath();
	if (!existsSync(path)) {
		throw new Error("no daemon unit installed (run `clawdi daemon install` first)");
	}
	const label = unitName();
	const target = `${launchdDomain()}/${label}`;
	// Hot restart a loaded job; bootstrap a stopped/ejected job from its plist.
	const isLoaded = tryRun(["launchctl", "print", target]);
	if (isLoaded && tryRun(["launchctl", "kickstart", "-k", target])) return;
	stopLaunchd();
	if (!bootstrapLaunchd(path, label)) {
		throw new Error(
			`launchctl could not (re)load ${label}. ` +
				`Try manually: launchctl bootstrap ${launchdDomain()} "${path}"`,
		);
	}
}

function bootstrapLaunchd(path: string, label: string): boolean {
	const domain = launchdDomain();
	// Match the former load -w behavior for previously disabled services.
	return (
		tryRun(["launchctl", "enable", `${domain}/${label}`]) &&
		tryRun(["launchctl", "bootstrap", domain, path])
	);
}

function restartSystemd(): void {
	const unit = unitFileName();
	const ok = tryRun(["systemctl", "--user", "restart", unit]);
	if (!ok) {
		throw new Error(
			`systemctl --user restart ${unit} failed. ` +
				`Check \`systemctl --user status ${unit}\` for details.`,
		);
	}
}

// ---------------------------------------------------------------------------
// macOS / launchd
// ---------------------------------------------------------------------------

function launchAgentsDir(): string {
	const dir = join(home(), "Library", "LaunchAgents");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function singletonPlistPath(): string {
	return join(launchAgentsDir(), `${unitName()}.plist`);
}

function installLaunchd(opts: InstallOpts): {
	unit: string;
	instructions: string;
	replaced: boolean;
} {
	const label = unitName();
	const context = currentDaemonInstallContext(opts);
	const invocation = context.invocation;
	const logDir = join(clawdiRoot(), "serve", "logs");
	if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

	// `KeepAlive=true` so launchd respawns on crash. `RunAtLoad`
	// starts at user login. `ThrottleInterval=10` prevents a
	// crashloop from melting the box. `StandardErrorPath` →
	// stderr (where we emit JSON logs) lands in a rotating
	// file the user can `tail`.
	//
	const programArgs = [invocation.command, ...invocation.args]
		.map((arg) => `    <string>${escapeXml(arg)}</string>`)
		.join("\n");
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardErrorPath</key>
	<string>${escapeXml(join(logDir, "daemon.stderr.log"))}</string>
  <key>StandardOutPath</key>
	<string>${escapeXml(join(logDir, "daemon.stdout.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home())}</string>${context.environment
			.map(
				({ key, value }) =>
					`\n    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
			)
			.join("")}
  </dict>
</dict>
</plist>
`;

	const path = singletonPlistPath();
	// Sample BEFORE we writeFileSync — caller wants to know
	// whether this install was a fresh write or replacing an
	// existing unit.
	const replaced = existsSync(path);
	// 0600 keeps captured configuration private. Bearer credentials
	// are passed through the owner-only auth-token file in ProgramArguments,
	// never through EnvironmentVariables. The
	// `writeFileSync({ mode })` option only fires at create time
	// — explicit chmodSync covers the overwrite case
	// (re-running install on top of a 0644 leftover from older
	// builds).
	// World-readable mode would let any other local user read the
	// captured configuration. launchd reads the file as the owning user,
	// so 0600 still loads correctly. The
	writeFileSync(path, plist, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		/* best effort — owner of the file is the only writer here */
	}

	// Remove a loaded definition before bootstrapping the updated plist.
	stopLaunchd();
	const loaded = bootstrapLaunchd(path, label);
	if (!loaded) {
		throw new Error(
			`Wrote daemon unit to ${path}, but launchctl activation failed. ` +
				`The unit was preserved. Try: launchctl bootstrap ${launchdDomain()} "${path}"`,
		);
	}

	const instructions = `Loaded ${label}. Tail logs with: tail -f ${join(logDir, "daemon.stderr.log")}`;
	return { unit: path, instructions, replaced };
}

function uninstallLaunchd(): { removed: boolean } {
	const path = singletonPlistPath();
	if (!existsSync(path)) return { removed: false };
	// Preserve the plist if stopping a loaded service fails.
	stopLaunchd();
	unlinkSync(path);
	return { removed: true };
}

function stopLaunchd(): void {
	const path = singletonPlistPath();
	if (!existsSync(path)) {
		throw new Error("no daemon unit installed (run `clawdi daemon install` first)");
	}
	const label = unitName();
	const target = `${launchdDomain()}/${label}`;
	if (!tryRun(["launchctl", "print", target])) return;
	if (tryRun(["launchctl", "bootout", target])) return;
	throw new Error(
		`Failed to stop running daemon ${label}. Try manually: launchctl bootout gui/$(id -u)/${label}`,
	);
}

function statusLaunchd(): string[] {
	const label = unitName();
	const lines: string[] = [];
	const path = singletonPlistPath();
	lines.push(`unit:    ${existsSync(path) ? path : "(not installed)"}`);
	const out = tryRunCapture(["launchctl", "list", label]);
	if (out !== null) {
		// launchctl list <label> prints a plist-ish dict on stdout
		// or fails if not loaded. We surface the raw output —
		// `PID = <n>` and `LastExitStatus = <n>` are the bits
		// the user wants.
		lines.push("launchctl:");
		for (const ln of out.split("\n").filter(Boolean)) {
			lines.push(`  ${ln}`);
		}
	} else {
		lines.push("launchctl: not loaded");
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Linux / systemd --user
// ---------------------------------------------------------------------------

function systemdUserDir(): string {
	const dir = join(home(), ".config", "systemd", "user");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function unitFileName(): string {
	return "clawdi-serve.service";
}

function unitPath(): string {
	return join(systemdUserDir(), unitFileName());
}

function installSystemd(opts: InstallOpts): {
	unit: string;
	instructions: string;
	replaced: boolean;
} {
	const context = currentDaemonInstallContext(opts);
	const invocation = context.invocation;
	const path = unitPath();
	const replaced = existsSync(path);

	// systemd `Environment="KEY=VALUE"` parses backslash + double-
	// quote inside the value. A $HOME containing `"` could close
	// the value early and append arbitrary directives; `\` + `n`
	// could be interpreted as a newline by some parsers. Reject
	// any control char, then escape `\` and `"` for the rest. We
	// trust process.execPath / argv[1] (kernel-provided, already
	// realpath'd) but $HOME is user-controlled.
	const homeValue = home();
	// biome-ignore lint/suspicious/noControlCharactersInRegex: targeting control chars on purpose
	if (/[\x00-\x1F\x7F]/.test(homeValue)) {
		throw new Error(
			"HOME contains control characters; refusing to write systemd unit. " +
				"Set HOME to a clean path before running install.",
		);
	}
	const escapedHome = homeValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");

	// Same control-char + quote escaping for every captured env
	// value. Reject control chars outright (would let an attacker
	// inject newlines + extra Environment= directives); escape
	// `\` and `"` for the rest.
	const envLines: string[] = [`Environment="HOME=${escapedHome}"`];
	for (const { key, value } of context.environment) {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: targeting control chars on purpose
		if (/[\x00-\x1F\x7F]/.test(value)) {
			throw new Error(
				`Env var ${key} contains control characters; refusing to write systemd unit.`,
			);
		}
		const esc = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
		envLines.push(`Environment="${key}=${esc}"`);
	}

	// `Restart=always` matches launchd's KeepAlive (which restarts
	// regardless of exit code). `Restart=on-failure` looks safer
	// but it's wrong for our auto-update path: when the daemon
	// detects a binary upgrade it exits cleanly with code 0 so
	// the next start picks up the new binary. systemd reads code
	// 0 as a deliberate stop and won't relaunch — the daemon
	// silently dies until the user logs in again. macOS launchd
	// already does the right thing here; align Linux to match.
	// `RestartPreventExitStatus=2` reserves a supervisor control outcome for
	// states that require user action (auth revoked, Agent disconnected, or a
	// schema older than this binary expects). It suppresses restart without
	// classifying those intentional stops as application crashes.
	// `WantedBy=default.target` is the systemd --user equivalent
	// of "start at user login"; requires `loginctl enable-linger
	// <user>` to fire on boot rather than first login session.
	// network-online.target belongs to the system manager, not the user
	// manager. The daemon retries network requests; RestartSec backs off exits.
	const unit = `[Unit]
Description=clawdi daemon

[Service]
Type=simple
ExecStart=${[invocation.command, ...invocation.args].map(shellEscape).join(" ")}
Restart=always
RestartSec=10
RestartPreventExitStatus=2
StandardOutput=journal
StandardError=journal
${envLines.join("\n")}

[Install]
WantedBy=default.target
`;

	// systemd.exec(5) says environment variables are not suitable for
	// passing secrets because they are exposed to unprivileged clients via
	// D-Bus; use the owner-only auth-token file instead. Keep the unit at
	// 0600 for captured non-secret configuration.
	writeFileSync(path, unit, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		/* best effort */
	}
	const activated =
		tryRun(["systemctl", "--user", "daemon-reload"]) &&
		tryRun(["systemctl", "--user", "enable", "--now", unitFileName()]) &&
		(!replaced || tryRun(["systemctl", "--user", "restart", unitFileName()]));
	if (!activated) {
		throw new Error(
			`Wrote daemon unit to ${path}, but systemctl activation failed. ` +
				"The unit was preserved. Try: " +
				`systemctl --user daemon-reload && systemctl --user enable --now ${unitFileName()}`,
		);
	}

	const instructions =
		`Enabled and started ${unitFileName()}. Tail logs with: journalctl --user -u ${unitFileName()} -f` +
		lingerHint();
	return { unit: path, instructions, replaced };
}

function lingerHint(): string {
	const uid = process.getuid?.();
	if (uid === undefined) return "";
	const linger = tryRunCapture([
		"loginctl",
		"show-user",
		String(uid),
		"--property=Linger",
		"--value",
	]);
	if (linger?.trim() !== "no") return "";
	return "\n  Sync stops at logout without lingering. To keep syncing: loginctl enable-linger $USER (may require privileges).";
}

function uninstallSystemd(): { removed: boolean } {
	const path = unitPath();
	if (!existsSync(path)) return { removed: false };
	stopSystemd();
	if (!tryRun(["systemctl", "--user", "disable", unitFileName()])) {
		throw new Error(`systemctl --user disable ${unitFileName()} failed.`);
	}
	unlinkSync(path);
	tryRun(["systemctl", "--user", "daemon-reload"]);
	return { removed: true };
}

function stopSystemd(): void {
	const path = unitPath();
	const unit = unitFileName();
	if (!existsSync(path)) {
		throw new Error("no daemon unit installed (run `clawdi daemon install` first)");
	}
	if (!tryRun(["systemctl", "--user", "stop", unit])) {
		throw new Error(
			`systemctl --user stop ${unit} failed. ` +
				`Check \`systemctl --user status ${unit}\` for details.`,
		);
	}
}

function statusSystemd(): string[] {
	const lines: string[] = [];
	const path = unitPath();
	lines.push(`unit:    ${existsSync(path) ? path : "(not installed)"}`);
	const out = tryRunCapture(["systemctl", "--user", "is-active", unitFileName()]);
	lines.push(`active:  ${out?.trim() ?? "unknown"}`);
	const sub = tryRunCapture(["systemctl", "--user", "status", unitFileName(), "--no-pager"]);
	if (sub !== null) {
		lines.push("systemctl:");
		// status is verbose; show first ~10 lines (header +
		// process tree) — that's all we need for triage.
		for (const ln of sub.split("\n").slice(0, 10)) lines.push(`  ${ln}`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryRun(argv: string[]): boolean {
	try {
		execFileSync(argv[0], argv.slice(1), { env: process.env, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function tryRunCapture(argv: string[]): string | null {
	try {
		// Pipe stdout (we want it), discard stdin/stderr — pre-fix
		// stderr leaked through, e.g. `launchctl list <label>`
		// failing with "Could not find service ..." printed during
		// `daemon restart`'s liveness probe.
		return execFileSync(argv[0], argv.slice(1), {
			encoding: "utf-8",
			env: process.env,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function shellEscape(s: string): string {
	// ExecStart is parsed by systemd, not a shell. Quote the entire argument,
	// including systemd's environment and specifier expansion characters.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: reject directive injection
	if (/[\x00-\x1F\x7F]/.test(s)) throw new Error("Daemon argument contains control characters.");
	if (!/[\\\s"'%$]/.test(s)) return s;
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function isSingletonDaemonInstalled(): boolean {
	const p = platform();
	if (p === "win32") return windowsTaskInstalled();
	const path = p === "darwin" ? singletonPlistPath() : p === "linux" ? unitPath() : null;
	return path ? existsSync(path) : false;
}

/** Health files survive a stop. Query the supervisor before reporting a live
 * daemon so update/startup recovery cannot mistake a fresh old heartbeat for
 * the new process. */
export function isSingletonDaemonRunning(): boolean {
	const p = platform();
	if (p === "win32") return windowsTaskRunning();
	if (p === "linux") {
		return tryRunCapture(["systemctl", "--user", "is-active", unitFileName()])?.trim() === "active";
	}
	if (p === "darwin") {
		const state = tryRunCapture(["launchctl", "list", unitName()]);
		return state !== null && /"?PID"?\s*=\s*[1-9]\d*/.test(state);
	}
	return false;
}

/** Health-file age check, used by `clawdi daemon status` even
 * before the unit framework reports anything. The daemon writes
 * `<state-dir>/health` after every successful heartbeat as a JSON
 * payload (`{"timestamp", "version"}`); file mtime within ~90s
 * means the daemon is alive and reaching the cloud. The `version`
 * field lets `daemon status` flag drift after a CLI upgrade
 * (daemon needs a restart to pick up the new bundle). Older
 * daemons wrote a bare ISO timestamp; the parser falls back to
 * that shape and reports `version: null`.
 */
export function readHealth(stateDir: string): {
	exists: boolean;
	ageSeconds: number | null;
	timestamp: string | null;
	version: string | null;
	executablePath?: string;
} {
	const p = join(stateDir, "health");
	if (!existsSync(p)) return { exists: false, ageSeconds: null, timestamp: null, version: null };
	try {
		const stat = statSync(p);
		const raw = readFileSync(p, "utf-8").trim();
		const age = Math.round((Date.now() - stat.mtimeMs) / 1000);
		// New JSON shape: parse and pull out fields. Old timestamp-
		// only shape: keep `timestamp = raw`, `version = null`.
		if (raw.startsWith("{")) {
			try {
				const parsed = JSON.parse(raw) as {
					timestamp?: string;
					version?: string;
					executablePath?: unknown;
				};
				return {
					exists: true,
					ageSeconds: age,
					timestamp: parsed.timestamp ?? null,
					version: parsed.version ?? null,
					...(typeof parsed.executablePath === "string"
						? { executablePath: parsed.executablePath }
						: {}),
				};
			} catch {
				/* fall through to legacy interpretation */
			}
		}
		return { exists: true, ageSeconds: age, timestamp: raw, version: null };
	} catch {
		return { exists: true, ageSeconds: null, timestamp: null, version: null };
	}
}
