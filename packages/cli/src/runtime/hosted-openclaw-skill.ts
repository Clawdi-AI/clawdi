import { basename, join, resolve } from "node:path";
import {
	ManagedSkillResourceError,
	managedSkillTargetMatchesSource,
	withManagedTargetRollback,
} from "./managed-skill-delivery";
import { executableExists, spawnRuntimeUserCommand } from "./runtime-user-command";

const OPENCLAW_AGENT_ID = "main";
const OPENCLAW_INSTALLED_TREE_EXCLUDES = new Set([".openclaw/source-origin.json"]);

function installedCommandPath(home: string): string | null {
	for (const candidate of [
		join(home, ".local", "bin", "openclaw"),
		join(home, ".openclaw", "bin", "openclaw"),
	])
		if (executableExists(candidate)) return candidate;
	return null;
}

function commandPath(home: string): string {
	const command = installedCommandPath(home);
	if (command) return command;
	throw new Error("installed OpenClaw Skill CLI is unavailable");
}
const targetDir = (workspaceRoot: string, skillId: string) =>
	join(workspaceRoot, "skills", skillId);

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
