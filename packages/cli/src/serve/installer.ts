/**
 * Generate / load / unload `clawdi serve` as a per-user OS
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
 * Per-agent unit name (e.g. `ai.clawdi.serve.claude_code`) so a
 * laptop running Claude Code AND Codex can have one daemon per
 * agent without arguing about which one owns the supervisor
 * slot. v1 daemon services exactly one agent per process.
 *
 * Windows is out of scope for v1 — explicitly told by the user.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

interface InstallOpts {
	agent: string;
	/** Pinned environment id baked into the unit's
	 * `--environment-id <id>` flag. Use ONLY when the caller
	 * explicitly opts a single agent into a non-default env (e.g.
	 * `clawdi serve install --agent codex --environment-id <id>`).
	 * Must not be derived from `process.env.CLAWDI_ENVIRONMENT_ID`
	 * during multi-agent install (`--all`); a shell-set env var
	 * would otherwise pin every agent unit to the same env. */
	environmentId?: string;
}

function home(): string {
	return process.env.HOME || homedir();
}

function unitName(agent: string): string {
	// launchd labels follow reverse-DNS; systemd unit names are
	// freeform but conventionally use a slug. We use the same
	// agent slug both ways for predictability.
	return `ai.clawdi.serve.${agent}`;
}

/** CLAWDI_* env vars that need to be baked into the supervisor
 * unit so the daemon under launchd / systemd sees them after
 * reboot. Capturing these at install time matches "the daemon
 * runs the same way it ran when I installed it" — the user's
 * mental model. Without this, an env-only auth setup
 * (`CLAWDI_AUTH_TOKEN=… clawdi serve install`) silently breaks
 * after the first reboot because the supervisor strips the
 * shell env and `~/.clawdi/auth.json` was never written.
 *
 * Whitelist deliberately narrow:
 *   - CLAWDI_AUTH_TOKEN / CLAWDI_API_URL: auth + endpoint
 *   - CLAWDI_STATE_DIR: state dir override
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
 * single env id leak into every agent's unit during
 * `clawdi serve install --all` — at runtime `resolveEnvironmentId`
 * prefers the env var over the per-agent file, so all daemons would
 * pin to the same env. Single-agent installs that need an explicit
 * pin pass `--environment-id` via `InstallOpts.environmentId`, which
 * gets baked into the unit's ProgramArguments (NOT
 * EnvironmentVariables) and so doesn't bleed across agents.
 */
const PERSISTED_ENV_KEYS = [
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_API_URL",
	"CLAWDI_STATE_DIR",
	// CLAWDI_HOME redirects the entire CLI state tree (auth.json,
	// environments, locks, serve queue/health) to a sibling
	// directory; honored by `lib/config.ts:clawdiDir()` and
	// `serve/paths.ts:getServeStateDir()`. Without persisting it
	// in the supervisor unit, an install run via
	// `CLAWDI_HOME=… clawdi serve install` would foreground-work
	// but the supervised daemon would fall back to the real
	// `~/.clawdi/` after the user logs out — splitting state
	// across two directories and breaking the isolation guarantee.
	"CLAWDI_HOME",
	"CLAWDI_SERVE_MODE",
	"CLAWDI_SERVE_DEBUG",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"HERMES_HOME",
	"OPENCLAW_STATE_DIR",
	"OPENCLAW_AGENT_ID",
] as const;

function capturedEnv(): { key: string; value: string }[] {
	const out: { key: string; value: string }[] = [];
	for (const key of PERSISTED_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined && value !== "") {
			out.push({ key, value });
		}
	}
	return out;
}

/** Path to the currently-running clawdi entry point. Both paths
 * are resolved via `realpathSync.native` so a malicious shim or
 * unstable symlink earlier in $PATH doesn't end up baked into
 * the launchd plist / systemd unit — the supervisor would happily
 * exec that shim on every boot for as long as the unit lives.
 *
 * We bake the absolute realpath into the unit because referencing
 * `clawdi` from $PATH would silently change what's actually
 * running on `npm i -g <other-version>`. */
function currentClawdiCommand(): string[] {
	// `process.argv[0]` is the node binary; `process.argv[1]`
	// is the bundled CLI entry. If the user invoked us via a
	// shell wrapper (`clawdi`), argv[1] resolves to the linked
	// JS file inside the npm install — exactly what we want.
	const rawNode = process.execPath;
	const rawEntry = process.argv[1] ?? "";
	if (!rawEntry) {
		throw new Error("could not resolve clawdi entry point from process.argv[1]");
	}
	let node: string;
	let entry: string;
	try {
		node = realpathSync.native(rawNode);
		entry = realpathSync.native(rawEntry);
	} catch (e) {
		throw new Error(
			`could not resolve absolute path for daemon binary: ${(e as Error).message}. ` +
				"Reinstall the CLI (npm i -g clawdi) and try again.",
		);
	}
	if (!isAbsolute(node) || !isAbsolute(entry)) {
		throw new Error(
			`refusing to install a daemon unit with a relative path ` +
				`(node=${node}, entry=${entry}). Reinstall the CLI from a clean shell.`,
		);
	}
	// Reject TypeScript source paths. A common dev-mode footgun:
	// running `bun run packages/cli/src/index.ts serve install`
	// from a clone bakes the .ts source path into the launchd /
	// systemd unit. After reboot, the supervisor launches that
	// unit via the system `node` binary which can't execute raw
	// TypeScript — daemon crashes silently in a respawn loop and
	// the user has no idea what's wrong because `launchctl load`
	// itself succeeded. Fail loudly at install time instead.
	if (/\.tsx?$/.test(entry)) {
		throw new Error(
			"refusing to install a daemon unit with a TypeScript source path " +
				`(entry=${entry}). The OS supervisor can't run .ts files. ` +
				"Build a JS bundle first (npm i -g clawdi or bun run build) " +
				"and re-run install from the installed binary.",
		);
	}
	return [node, entry];
}

export function install(opts: InstallOpts): { unit: string; instructions: string } {
	const p = platform();
	if (p === "darwin") return installLaunchd(opts);
	if (p === "linux") return installSystemd(opts);
	throw new Error(`unsupported platform for service install: ${p}`);
}

export function uninstall(opts: InstallOpts): { removed: boolean } {
	const p = platform();
	if (p === "darwin") return uninstallLaunchd(opts);
	if (p === "linux") return uninstallSystemd(opts);
	throw new Error(`unsupported platform for service uninstall: ${p}`);
}

export function statusLines(opts: InstallOpts): string[] {
	const p = platform();
	if (p === "darwin") return statusLaunchd(opts);
	if (p === "linux") return statusSystemd(opts);
	return [`unsupported platform: ${p}`];
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
	return join(launchAgentsDir(), `${unitName(agent)}.plist`);
}

function installLaunchd(opts: InstallOpts): { unit: string; instructions: string } {
	validateEnvironmentId(opts.environmentId);
	const label = unitName(opts.agent);
	const [node, entry] = currentClawdiCommand();
	const logDir = join(home(), ".clawdi", "serve", "logs");
	if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

	// `KeepAlive=true` so launchd respawns on crash. `RunAtLoad`
	// starts at user login. `ThrottleInterval=10` prevents a
	// crashloop from melting the box. `StandardErrorPath` →
	// stderr (where we emit JSON logs) lands in a rotating
	// file the user can `tail`.
	//
	// `--environment-id <id>` is appended to ProgramArguments
	// (NOT EnvironmentVariables) when the caller pinned an env_id
	// for this specific agent. Putting it in argv keeps it scoped
	// to this unit; an EnvironmentVariables entry could leak
	// across multi-agent installs if every unit picked up the same
	// shell env var.
	const envIdArgs = opts.environmentId
		? `\n    <string>--environment-id</string>\n    <string>${escapeXml(opts.environmentId)}</string>`
		: "";
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(entry)}</string>
    <string>serve</string>
    <string>--agent</string>
    <string>${escapeXml(opts.agent)}</string>${envIdArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, `${opts.agent}.stderr.log`))}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, `${opts.agent}.stdout.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home())}</string>${capturedEnv()
			.map(
				({ key, value }) =>
					`\n    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
			)
			.join("")}
  </dict>
</dict>
</plist>
`;

	const path = plistPath(opts.agent);
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

	const instructions = loaded
		? `Loaded ${label}. Tail logs with: tail -f ${join(logDir, `${opts.agent}.stderr.log`)}`
		: `Wrote plist to ${path}, but launchctl load failed (try: launchctl load -w "${path}").`;
	return { unit: path, instructions };
}

function uninstallLaunchd(opts: InstallOpts): { removed: boolean } {
	const path = plistPath(opts.agent);
	if (!existsSync(path)) return { removed: false };
	tryRun(["launchctl", "unload", path]);
	unlinkSync(path);
	return { removed: true };
}

function statusLaunchd(opts: InstallOpts): string[] {
	const label = unitName(opts.agent);
	const lines: string[] = [];
	const path = plistPath(opts.agent);
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

function unitPath(agent: string): string {
	return join(systemdUserDir(), `clawdi-serve-${agent}.service`);
}

function installSystemd(opts: InstallOpts): { unit: string; instructions: string } {
	validateEnvironmentId(opts.environmentId);
	const [node, entry] = currentClawdiCommand();
	const path = unitPath(opts.agent);

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
	for (const { key, value } of capturedEnv()) {
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
	// `RestartPreventExitStatus=2` reserves a one-shot abort code
	// for genuinely-broken configs (auth revoked, schema older
	// than this binary expects) so we can opt out of restart
	// without flipping the whole policy.
	// `WantedBy=default.target` is the systemd --user equivalent
	// of "start at user login"; requires `loginctl enable-linger
	// <user>` to fire on boot rather than first login session.
	const unit = `[Unit]
Description=clawdi serve daemon (${opts.agent})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${shellEscape(node)} ${shellEscape(entry)} serve --agent ${shellEscape(opts.agent)}${
		opts.environmentId ? ` --environment-id ${shellEscape(opts.environmentId)}` : ""
	}
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
	tryRun(["systemctl", "--user", "daemon-reload"]);
	const enabled = tryRun([
		"systemctl",
		"--user",
		"enable",
		"--now",
		`clawdi-serve-${opts.agent}.service`,
	]);

	const instructions = enabled
		? `Enabled and started clawdi-serve-${opts.agent}.service. Tail logs with: journalctl --user -u clawdi-serve-${opts.agent} -f`
		: `Wrote ${path} but systemctl enable failed. Try: systemctl --user enable --now clawdi-serve-${opts.agent}.service`;
	return { unit: path, instructions };
}

function uninstallSystemd(opts: InstallOpts): { removed: boolean } {
	const path = unitPath(opts.agent);
	if (!existsSync(path)) return { removed: false };
	tryRun(["systemctl", "--user", "disable", "--now", `clawdi-serve-${opts.agent}.service`]);
	unlinkSync(path);
	tryRun(["systemctl", "--user", "daemon-reload"]);
	return { removed: true };
}

function statusSystemd(opts: InstallOpts): string[] {
	const lines: string[] = [];
	const path = unitPath(opts.agent);
	lines.push(`unit:    ${existsSync(path) ? path : "(not installed)"}`);
	const out = tryRunCapture([
		"systemctl",
		"--user",
		"is-active",
		`clawdi-serve-${opts.agent}.service`,
	]);
	lines.push(`active:  ${out?.trim() ?? "unknown"}`);
	const sub = tryRunCapture([
		"systemctl",
		"--user",
		"status",
		`clawdi-serve-${opts.agent}.service`,
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
		execFileSync(argv[0], argv.slice(1), { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function tryRunCapture(argv: string[]): string | null {
	try {
		return execFileSync(argv[0], argv.slice(1), { encoding: "utf-8" });
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

/** Validate `environmentId` is safe to bake into a unit's argv.
 * Defense-in-depth — the install command should already pass a
 * UUID, but injecting a control char or shell metachar via a
 * compromised env file would otherwise let an attacker append
 * arbitrary `--flag` arguments. Allow only the canonical UUID
 * shape. */
function validateEnvironmentId(envId: string | undefined): void {
	if (envId === undefined) return;
	const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
	if (!UUID_RE.test(envId)) {
		throw new Error(
			`refusing to install with non-UUID --environment-id (${envId}). ` +
				"Pass a valid environment id from `clawdi setup` output.",
		);
	}
}

function shellEscape(s: string): string {
	// systemd unit ExecStart accepts a quoted form for paths
	// containing spaces. Wrap in double-quotes and escape any
	// embedded ones — sufficient for the macOS-ish HOME paths
	// we'd ever see in practice.
	if (!/[\s"']/.test(s)) return s;
	return `"${s.replace(/"/g, '\\"')}"`;
}

/** Health-file age check, used by `clawdi serve status` even
 * before the unit framework reports anything. The daemon writes
 * `<state-dir>/health` after every successful heartbeat with
 * the current ISO timestamp — file mtime within ~90s means the
 * daemon is alive and reaching the cloud. */
export function readHealth(stateDir: string): {
	exists: boolean;
	ageSeconds: number | null;
	timestamp: string | null;
} {
	const p = join(stateDir, "health");
	if (!existsSync(p)) return { exists: false, ageSeconds: null, timestamp: null };
	try {
		const stat = statSync(p);
		const ts = readFileSync(p, "utf-8").trim();
		const age = Math.round((Date.now() - stat.mtimeMs) / 1000);
		return { exists: true, ageSeconds: age, timestamp: ts };
	} catch {
		return { exists: true, ageSeconds: null, timestamp: null };
	}
}
