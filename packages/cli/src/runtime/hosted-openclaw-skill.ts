import { basename, isAbsolute, join, resolve } from "node:path";
import {
	type OpenClawAgentWorkspace,
	parseOpenClawAgentWorkspaces,
} from "../adapters/openclaw-workspace";
import {
	ManagedSkillResourceError,
	managedSkillTargetMatchesSource,
	withManagedTargetRollback,
} from "./managed-skill-delivery";
import {
	executableExists,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";
import { parseSystemctlShow, systemctlPath } from "./systemd";

const OPENCLAW_AGENT_ID = "main";
const OPENCLAW_INSTALLED_TREE_EXCLUDES = new Set([".openclaw/source-origin.json"]);
const OPENCLAW_CONFIG_PROBE_TIMEOUT_MS = 15_000;
const OPENCLAW_CONFIG_REPAIR_TIMEOUT_MS = 120_000;
const OPENCLAW_GATEWAY_UNIT = "openclaw-gateway.service";
const OPENCLAW_GATEWAY_TRANSITION_RETRIES = 2;
const OPENCLAW_GATEWAY_TRANSITION_RETRY_DELAY_MS = 3_000;

function installedCommandPath(home: string): string | null {
	return withRuntimeUserFileAccess(() => {
		for (const candidate of [
			join(home, ".local", "bin", "openclaw"),
			join(home, ".openclaw", "bin", "openclaw"),
		])
			if (executableExists(candidate)) return candidate;
		return null;
	});
}

function commandPath(home: string): string {
	const command = installedCommandPath(home);
	if (command) return command;
	throw new Error("installed OpenClaw Skill CLI is unavailable");
}
const targetDir = (workspaceRoot: string, skillId: string) =>
	join(workspaceRoot, "skills", skillId);

function parseOfficialWorkspaceRoster(stdout: string): string {
	let roster: OpenClawAgentWorkspace[];
	try {
		roster = parseOpenClawAgentWorkspaces(stdout);
	} catch {
		throw new Error("OpenClaw official agent workspace roster is malformed");
	}
	const main = roster.filter((entry) => entry.id === OPENCLAW_AGENT_ID);
	if (main.length !== 1 || !isAbsolute(main[0].workspace))
		throw new Error("OpenClaw official agent workspace roster is malformed");
	return resolve(main[0].workspace);
}

function invalidConfigValidation(result: ReturnType<typeof spawnRuntimeUserCommand>): boolean {
	if (result.status !== 1 || result.error || result.signal) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(result.stdout));
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const validation = parsed as Record<string, unknown>;
	if (
		validation.valid !== false ||
		typeof validation.path !== "string" ||
		!Array.isArray(validation.issues) ||
		validation.issues.length === 0
	) {
		return false;
	}
	return validation.issues.every((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const issue = value as Record<string, unknown>;
		return typeof issue.path === "string" && typeof issue.message === "string";
	});
}

function repairInvalidConfig(command: string, home: string): boolean {
	const validation = spawnRuntimeUserCommand(
		command,
		["config", "validate", "--json"],
		home,
		home,
		{ timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS, maxBufferBytes: 1024 * 1024 },
	);
	if (!invalidConfigValidation(validation)) return false;
	const repair = spawnRuntimeUserCommand(
		command,
		["doctor", "--fix", "--non-interactive"],
		home,
		home,
		{ timeoutMs: OPENCLAW_CONFIG_REPAIR_TIMEOUT_MS, maxBufferBytes: 4 * 1024 * 1024 },
	);
	if (repair.status !== 0) throw new Error("OpenClaw official config repair failed");
	return true;
}

function openClawGatewayIsTransitioning(home: string): boolean {
	const result = spawnRuntimeUserCommand(
		systemctlPath(),
		["--user", "show", OPENCLAW_GATEWAY_UNIT, "--property=LoadState", "--property=ActiveState"],
		home,
		home,
		{ timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS, maxBufferBytes: 64 * 1024 },
	);
	if (result.status !== 0) return false;
	const state = parseSystemctlShow(String(result.stdout));
	return (
		state.LoadState === "loaded" &&
		(state.ActiveState === "activating" || state.ActiveState === "deactivating")
	);
}

function waitForOpenClawGatewayTransition(): void {
	Atomics.wait(
		new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
		0,
		0,
		OPENCLAW_GATEWAY_TRANSITION_RETRY_DELAY_MS,
	);
}

export function resolveHostedOpenClawWorkspace(
	home: string,
	repairInvalidConfigOnFailure = false,
): string {
	const command = commandPath(home);
	let result = spawnRuntimeUserCommand(command, ["agents", "list", "--json"], home, home, {
		timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS,
		maxBufferBytes: 1024 * 1024,
	});
	for (
		let attempt = 0;
		result.status !== 0 &&
		attempt < OPENCLAW_GATEWAY_TRANSITION_RETRIES &&
		openClawGatewayIsTransitioning(home);
		attempt += 1
	) {
		waitForOpenClawGatewayTransition();
		result = spawnRuntimeUserCommand(command, ["agents", "list", "--json"], home, home, {
			timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS,
			maxBufferBytes: 1024 * 1024,
		});
	}
	if (result.status !== 0 && repairInvalidConfigOnFailure && repairInvalidConfig(command, home)) {
		result = spawnRuntimeUserCommand(command, ["agents", "list", "--json"], home, home, {
			timeoutMs: OPENCLAW_CONFIG_PROBE_TIMEOUT_MS,
			maxBufferBytes: 1024 * 1024,
		});
	}
	if (result.status !== 0) {
		throw new Error("OpenClaw official agent workspace roster is unavailable");
	}
	return parseOfficialWorkspaceRoster(String(result.stdout));
}

function assertOfficialWorkspace(input: { home: string; workspaceRoot: string }): void {
	if (resolveHostedOpenClawWorkspace(input.home) !== resolve(input.workspaceRoot))
		throw new Error("OpenClaw official agent workspace changed during Skill reconciliation");
}

function commandFailureDetail(result: ReturnType<typeof spawnRuntimeUserCommand>): string {
	const details: string[] = [];
	if (result.error) details.push(`spawn error: ${result.error.message}`);
	if (result.signal) details.push(`terminated by signal ${result.signal}`);
	for (const output of [result.stderr, result.stdout]) {
		if (typeof output === "string" && output.trim()) {
			details.push(output.trim());
			break;
		}
	}
	if (details.length === 0 && typeof result.status === "number") {
		details.push(`exit code ${result.status} without output`);
	}
	return details.join("; ") || "process failed without details";
}

export function activateHostedOpenClawSkill(input: {
	home: string;
	workspaceRoot: string;
	sourceDir: string;
	targetDir: string;
}): void {
	const skillId = basename(input.targetDir);
	const target = resolve(input.targetDir);
	if (target !== resolve(targetDir(input.workspaceRoot, skillId))) {
		throw new ManagedSkillResourceError("OpenClaw Skill target is invalid");
	}
	assertOfficialWorkspace(input);
	withManagedTargetRollback({
		target,
		operation: () => {
			// The roster may reference a workspace OpenClaw has not created yet on first run.
			const result = spawnRuntimeUserCommand(
				commandPath(input.home),
				[
					"skills",
					"install",
					input.sourceDir,
					"--agent",
					OPENCLAW_AGENT_ID,
					"--as",
					skillId,
					"--force",
				],
				input.home,
				input.home,
				{ timeoutMs: 120_000, maxBufferBytes: 1024 * 1024 },
			);
			if (result.status !== 0) {
				throw new ManagedSkillResourceError(
					`OpenClaw official Skill install failed: ${commandFailureDetail(result)}`,
				);
			}
			assertOfficialWorkspace(input);
			if (
				!managedSkillTargetMatchesSource(input.sourceDir, target, {
					exclude: OPENCLAW_INSTALLED_TREE_EXCLUDES,
				})
			) {
				throw new ManagedSkillResourceError("OpenClaw Skill activation changed exact source bytes");
			}
		},
	});
}
