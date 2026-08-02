/**
 * Generate / load / unload `clawdi daemon` as a per-user OS
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
 * every registered agent's sync engine. Older per-agent units are
 * still detected so setup/install can remove them during migration.
 *
 * Windows is not part of v1 — explicitly told by the user.
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
import {
	type CurrentCliInvocation,
	resolveCurrentCliInvocation,
	resolveCurrentCliLayout,
} from "../lib/current-cli-invocation";

interface InstallOpts {
	/** Internal migration hook for removing pre-singleton per-agent units. */
	agent?: string;
	rpcHost?: string;
	rpcPort?: number;
	rpcAllowRemote?: boolean;
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

function daemonProgramArgs(opts: InstallOpts): string[] {
	if (opts.agent) return ["daemon", "run", "--agent", opts.agent];
	return ["daemon", "run"];
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
 *   - CLAWDI_AUTH_TOKEN / CLAWDI_API_URL: auth + endpoint
 *   - CLAWDI_STATE_DIR: state dir override
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
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_API_URL",
	"CLAWDI_STATE_DIR",
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

function capturedEnv(opts: InstallOpts = {}): { key: string; value: string }[] {
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

/** Resolve this exact CLI installation for a supervisor-owned daemon. */
function currentDaemonInvocation(opts: InstallOpts): CurrentCliInvocation {
	let invocation: CurrentCliInvocation;
	try {
		const layout = resolveCurrentCliLayout();
		if (layout.kind === "native" && !layout.nativeOwnership) {
			throw new Error(
				"an unowned native executable cannot install a daemon; install the native distribution with install.sh first",
			);
		}
		invocation = resolveCurrentCliInvocation(daemonProgramArgs(opts));
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
	// the user has no idea what's wrong because `launchctl load`
	// itself succeeded. Fail loudly at install time instead.
	if (invocation.entryPath && /\.tsx?$/.test(invocation.entryPath)) {
		throw new Error(
			"refusing to install a daemon unit with a TypeScript source path " +
				`(entry=${invocation.entryPath}). The OS supervisor can't run .ts files. ` +
				"Build a JS bundle first (npm i -g clawdi or bun run build) " +
				"and re-run install from the installed binary.",
		);
	}
	return invocation;
}

export function install(opts: InstallOpts = {}): {
	unit: string;
	instructions: string;
	replaced: boolean;
} {
	const p = platform();
	if (p === "darwin") return installLaunchd(opts);
	if (p === "linux") return installSystemd(opts);
	throw new Error(`unsupported platform for service install: ${p}`);
}

export function uninstall(opts: InstallOpts = {}): { removed: boolean } {
	const p = platform();
	if (p === "darwin") return uninstallLaunchd(opts);
	if (p === "linux") return uninstallSystemd(opts);
	throw new Error(`unsupported platform for service uninstall: ${p}`);
}

export function statusLines(opts: InstallOpts = {}): string[] {
	const p = platform();
	if (p === "darwin") return statusLaunchd(opts);
	if (p === "linux") return statusSystemd(opts);
	return [`unsupported platform: ${p}`];
}

/** Restart an already-installed daemon unit. Throws if no unit is
 * installed (caller should install first) or if the supervisor
 * refuses to restart (corrupt unit, permissions, etc). */
export function restart(opts: InstallOpts = {}): void {
	const p = platform();
	if (p === "darwin") {
		restartLaunchd(opts);
	} else if (p === "linux") {
		restartSystemd(opts);
	} else {
		throw new Error(`unsupported platform for service restart: ${p}`);
	}
}

function restartLaunchd(opts: InstallOpts): void {
	const path = opts.agent ? plistPath(opts.agent) : singletonPlistPath();
	if (!existsSync(path)) {
		throw new Error("no daemon unit installed (run `clawdi daemon install` first)");
	}
	const label = opts.agent ? legacyUnitName(opts.agent) : unitName();
	const target = `gui/${process.getuid?.() ?? 501}/${label}`;
	// Two restart shapes depending on launchd's view of the unit:
	//   - Loaded: hot restart via `kickstart -k` (kills the running
	//     job and lets launchd respawn it; preserves the unit's
	//     OnDemand/KeepAlive policies).
	//   - Unloaded but plist exists (launchd auto-ejected after
	//     enough crash-loop exits, or user manually `bootout`'d
	//     without removing the file): cold reload via unload+load.
	// Pre-fix `restart` always tried kickstart and gave up with a
	// "kickstart failed" error when the unit was ejected — the user
	// then had to manually `launchctl load -w <path>` themselves.
	const isLoaded = tryRunCapture(["launchctl", "list", label]) !== null;
	if (isLoaded && tryRun(["launchctl", "kickstart", "-k", target])) return;
	tryRun(["launchctl", "unload", path]);
	if (!tryRun(["launchctl", "load", "-w", path])) {
		throw new Error(
			`launchctl could not (re)load ${label}. ` + `Try manually: launchctl load -w "${path}"`,
		);
	}
}

function restartSystemd(opts: InstallOpts): void {
	const unit = unitFileName(opts.agent);
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

function plistPath(agent: string): string {
	return join(launchAgentsDir(), `${legacyUnitName(agent)}.plist`);
}

function singletonPlistPath(): string {
	return join(launchAgentsDir(), `${unitName()}.plist`);
}

function legacyUnitName(agent: string): string {
	return `ai.clawdi.serve.${agent}`;
}

function installLaunchd(opts: InstallOpts): {
	unit: string;
	instructions: string;
	replaced: boolean;
} {
	const label = opts.agent ? legacyUnitName(opts.agent) : unitName();
	const invocation = currentDaemonInvocation(opts);
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
  <string>${escapeXml(join(logDir, `${opts.agent ?? "daemon"}.stderr.log`))}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, `${opts.agent ?? "daemon"}.stdout.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home())}</string>${capturedEnv(opts)
			.map(
				({ key, value }) =>
					`\n    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
			)
			.join("")}
  </dict>
</dict>
</plist>
`;

	const path = opts.agent ? plistPath(opts.agent) : singletonPlistPath();
	// Sample BEFORE we writeFileSync — caller wants to know
	// whether this install was a fresh write or replacing an
	// existing unit.
	const replaced = existsSync(path);
	// 0600: the plist body inlines `CLAWDI_AUTH_TOKEN` and any
	// other captured shell env vars under `<key>EnvironmentVariables</key>`.
	// World-readable mode would let any other local user on a
	// multi-user host read the API token. launchd reads the file
	// as the owning user, so 0600 still loads correctly. The
	// `writeFileSync({ mode })` option only fires at create time
	// — explicit chmodSync covers the overwrite case
	// (re-running install on top of a 0644 leftover from older
	// builds).
	writeFileSync(path, plist, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		/* best effort — owner of the file is the only writer here */
	}

	// Best-effort load. If an old version is already loaded,
	// unload first — `launchctl load -w` is idempotent on the
	// label but the file path swap still requires a clean
	// reload to pick up edits.
	tryRun(["launchctl", "unload", path]);
	const loaded = tryRun(["launchctl", "load", "-w", path]);
	if (!loaded) {
		throw new Error(
			`Wrote daemon unit to ${path}, but launchctl activation failed. ` +
				`The unit was preserved. Try: launchctl load -w "${path}"`,
		);
	}

	const instructions = `Loaded ${label}. Tail logs with: tail -f ${join(logDir, `${opts.agent ?? "daemon"}.stderr.log`)}`;
	return { unit: path, instructions, replaced };
}

function uninstallLaunchd(opts: InstallOpts): { removed: boolean } {
	const path = opts.agent ? plistPath(opts.agent) : singletonPlistPath();
	if (!existsSync(path)) return { removed: false };
	const label = opts.agent ? legacyUnitName(opts.agent) : unitName();
	// Stop the daemon BEFORE removing the plist. Pre-fix this used a
	// bare `tryRun(["launchctl", "unload", path])` and ignored the
	// return code, then `unlinkSync(path)` regardless — so a
	// failed unload (corrupt plist, label mismatch, race) left the
	// daemon process running while the unit file was gone, with the
	// CLI confidently reporting "✓ Removed".
	//
	// macOS has two stop forms:
	//   - `launchctl unload <path>`: legacy, works for plists under
	//     ~/Library/LaunchAgents.
	//   - `launchctl bootout gui/<uid>/<label>`: modern (10.10+),
	//     works regardless of whether the plist file still exists.
	// Try unload first; fall back to bootout. Only proceed to
	// unlink the plist after we've confirmed the daemon is stopped
	// (or was never loaded in the first place).
	const wasLoaded = tryRunCapture(["launchctl", "list", label]) !== null;
	if (wasLoaded) {
		const stopped =
			tryRun(["launchctl", "unload", path]) ||
			tryRun(["launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${label}`]);
		if (!stopped) {
			throw new Error(
				`Failed to stop running daemon ${label}. Try manually: ` +
					`launchctl bootout gui/$(id -u)/${label} && rm "${path}"`,
			);
		}
	}
	unlinkSync(path);
	return { removed: true };
}

function statusLaunchd(opts: InstallOpts): string[] {
	const label = opts.agent ? legacyUnitName(opts.agent) : unitName();
	const lines: string[] = [];
	const path = opts.agent ? plistPath(opts.agent) : singletonPlistPath();
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

function unitFileName(agent?: string): string {
	return agent ? `clawdi-serve-${agent}.service` : "clawdi-serve.service";
}

function unitPath(agent?: string): string {
	return join(systemdUserDir(), unitFileName(agent));
}

function installSystemd(opts: InstallOpts): {
	unit: string;
	instructions: string;
	replaced: boolean;
} {
	const invocation = currentDaemonInvocation(opts);
	const path = unitPath(opts.agent);
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
	const escapedHome = homeValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

	// Same control-char + quote escaping for every captured env
	// value. Reject control chars outright (would let an attacker
	// inject newlines + extra Environment= directives); escape
	// `\` and `"` for the rest.
	const envLines: string[] = [`Environment="HOME=${escapedHome}"`];
	for (const { key, value } of capturedEnv(opts)) {
		// biome-ignore lint/suspicious/noControlCharactersInRegex: targeting control chars on purpose
		if (/[\x00-\x1F\x7F]/.test(value)) {
			throw new Error(
				`Env var ${key} contains control characters; refusing to write systemd unit.`,
			);
		}
		const esc = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
	const unit = `[Unit]
Description=clawdi daemon
After=network-online.target
Wants=network-online.target

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

	// 0600: same reasoning as the macOS plist above — the unit's
	// `Environment="CLAWDI_AUTH_TOKEN=…"` line carries the API
	// token, so any other local user with read access to
	// `~/.config/systemd/user/` would otherwise lift it. systemd
	// --user reads as the owning user, so 0600 still loads.
	writeFileSync(path, unit, { mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		/* best effort */
	}
	const activated =
		tryRun(["systemctl", "--user", "daemon-reload"]) &&
		tryRun(["systemctl", "--user", "enable", "--now", unitFileName(opts.agent)]);
	if (!activated) {
		throw new Error(
			`Wrote daemon unit to ${path}, but systemctl activation failed. ` +
				"The unit was preserved. Try: " +
				`systemctl --user daemon-reload && systemctl --user enable --now ${unitFileName(opts.agent)}`,
		);
	}

	const instructions = `Enabled and started ${unitFileName(opts.agent)}. Tail logs with: journalctl --user -u ${unitFileName(opts.agent)} -f`;
	return { unit: path, instructions, replaced };
}

function uninstallSystemd(opts: InstallOpts): { removed: boolean } {
	const path = unitPath(opts.agent);
	if (!existsSync(path)) return { removed: false };
	tryRun(["systemctl", "--user", "disable", "--now", unitFileName(opts.agent)]);
	unlinkSync(path);
	tryRun(["systemctl", "--user", "daemon-reload"]);
	return { removed: true };
}

function statusSystemd(opts: InstallOpts): string[] {
	const lines: string[] = [];
	const path = unitPath(opts.agent);
	lines.push(`unit:    ${existsSync(path) ? path : "(not installed)"}`);
	const out = tryRunCapture(["systemctl", "--user", "is-active", unitFileName(opts.agent)]);
	lines.push(`active:  ${out?.trim() ?? "unknown"}`);
	const sub = tryRunCapture([
		"systemctl",
		"--user",
		"status",
		unitFileName(opts.agent),
		"--no-pager",
	]);
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
	// systemd unit ExecStart accepts a quoted form for paths
	// containing spaces. Wrap in double-quotes and escape any
	// embedded ones — sufficient for the macOS-ish HOME paths
	// we'd ever see in practice.
	if (!/[\s"']/.test(s)) return s;
	return `"${s.replace(/"/g, '\\"')}"`;
}

/** Scan the OS supervisor for every clawdi daemon unit installed
 * by older `clawdi daemon install --agent <agent>` builds,
 * regardless of whether its agent is still registered in
 * `~/.clawdi/environments/`. Used only for migration cleanup and
 * logout warnings.
 *
 * Cheap implementation: enumerate `~/Library/LaunchAgents/` (macOS)
 * or `~/.config/systemd/user/` (Linux) and pattern-match against
 * the clawdi unit name shape. Skips agents not in `AGENT_TYPES` so
 * a malicious filename can't smuggle into the iteration.
 */
type KnownAgent = "claude_code" | "codex" | "openclaw" | "hermes";
export function listInstalledAgents(): KnownAgent[] {
	const knownAgents: KnownAgent[] = ["claude_code", "codex", "openclaw", "hermes"];
	const installed: KnownAgent[] = [];
	for (const agent of knownAgents) {
		const p = platform();
		const path = p === "darwin" ? plistPath(agent) : p === "linux" ? unitPath(agent) : null;
		if (path && existsSync(path)) installed.push(agent);
	}
	return installed;
}

export type InstalledDaemonTarget = KnownAgent | "daemon";

export function isSingletonDaemonInstalled(): boolean {
	const p = platform();
	const path = p === "darwin" ? singletonPlistPath() : p === "linux" ? unitPath() : null;
	return path ? existsSync(path) : false;
}

export function listInstalledDaemonTargets(): InstalledDaemonTarget[] {
	const targets: InstalledDaemonTarget[] = [];
	if (isSingletonDaemonInstalled()) targets.push("daemon");
	targets.push(...listInstalledAgents());
	return targets;
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
				const parsed = JSON.parse(raw) as { timestamp?: string; version?: string };
				return {
					exists: true,
					ageSeconds: age,
					timestamp: parsed.timestamp ?? null,
					version: parsed.version ?? null,
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
