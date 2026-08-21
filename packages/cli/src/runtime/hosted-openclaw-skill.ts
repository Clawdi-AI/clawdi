import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	type OpenClawAgentWorkspace,
	parseOpenClawAgentWorkspaces,
} from "../adapters/openclaw-workspace";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import {
	managedSkillMarkerMatchesIdentity,
	managedSkillMarkerOwnsTarget,
	managedSkillReceiptMatchesIdentity,
	withManagedTargetRollback,
	withStagedManagedSkill,
	writeManagedSkillReceipt,
} from "./managed-skill-delivery";
import {
	executableExists,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";

const OPENCLAW_AGENT_ID = "main";
const SOURCE_RECEIPT = ".openclaw/source-origin.json";
const EXCLUDED_NATIVE_FILES = new Set([SOURCE_RECEIPT]);
const RECEIPT_SCHEMA = "clawdi.openclawManifestSkillReceipt.v2";

export interface HostedOpenClawSkillDriver {
	resolveWorkspace(input: { home: string; repairInvalidConfig?: boolean }): string;
	installDirectory(input: {
		home: string;
		workspaceRoot: string;
		skillId: string;
		sourceDir: string;
		ownershipIdentity: string;
		previouslyReserved?: boolean;
	}): "installed" | "unchanged";
	install(input: {
		home: string;
		workspaceRoot: string;
		skill: PreparedHostedSourcedSkill;
		previouslyReserved?: boolean;
	}): "installed" | "unchanged";
	anchorOwnership(input: {
		workspaceRoot: string;
		skillId: string;
		ownershipIdentity: string;
	}): void;
	hasOwnershipReceipt(input: {
		workspaceRoot: string;
		skillId: string;
		ownershipIdentity: string;
	}): boolean;
	verifyOwned(input: { workspaceRoot: string; skill: PreparedHostedSourcedSkill }): boolean;
	cleanupManifestOwned(input: {
		workspaceRoot: string;
		skillId: string;
		ownershipIdentity: string;
	}): "absent" | "removed";
}

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
const receiptPath = (workspaceRoot: string, skillId: string) =>
	join(workspaceRoot, "skills", ".clawdi-manifest-receipts", `${skillId}.json`);
function receiptInput(workspaceRoot: string, skillId: string, ownershipIdentity: string) {
	return {
		path: receiptPath(workspaceRoot, skillId),
		schemaVersion: RECEIPT_SCHEMA,
		skillId,
		ownershipIdentity,
		target: targetDir(workspaceRoot, skillId),
		exclude: EXCLUDED_NATIVE_FILES,
	};
}

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
		{ timeoutMs: 15_000, maxBufferBytes: 1024 * 1024 },
	);
	if (!invalidConfigValidation(validation)) return false;
	const repair = spawnRuntimeUserCommand(
		command,
		["doctor", "--fix", "--non-interactive"],
		home,
		home,
		{ timeoutMs: 120_000, maxBufferBytes: 4 * 1024 * 1024 },
	);
	if (repair.status !== 0) throw new Error("OpenClaw official config repair failed");
	return true;
}

function resolveOfficialWorkspace(home: string, repairInvalidConfigOnFailure = false): string {
	const command = commandPath(home);
	let result = spawnRuntimeUserCommand(command, ["agents", "list", "--json"], home, home, {
		timeoutMs: 15_000,
		maxBufferBytes: 1024 * 1024,
	});
	if (result.status !== 0 && repairInvalidConfigOnFailure && repairInvalidConfig(command, home)) {
		result = spawnRuntimeUserCommand(command, ["agents", "list", "--json"], home, home, {
			timeoutMs: 15_000,
			maxBufferBytes: 1024 * 1024,
		});
	}
	if (result.status !== 0) {
		throw new Error("OpenClaw official agent workspace roster is unavailable");
	}
	return parseOfficialWorkspaceRoster(String(result.stdout));
}

function assertOfficialWorkspace(input: { home: string; workspaceRoot: string }): void {
	if (resolveOfficialWorkspace(input.home) !== resolve(input.workspaceRoot))
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

export const hostedOpenClawSkillDriver: HostedOpenClawSkillDriver = {
	resolveWorkspace(input) {
		return withRuntimeUserFileAccess(() =>
			resolveOfficialWorkspace(input.home, input.repairInvalidConfig),
		);
	},
	installDirectory(input) {
		return withRuntimeUserFileAccess(() => {
			const target = targetDir(input.workspaceRoot, input.skillId);
			const receipt = receiptInput(input.workspaceRoot, input.skillId, input.ownershipIdentity);
			if (managedSkillReceiptMatchesIdentity(receipt)) return "unchanged";
			if (existsSync(target) && !input.previouslyReserved && !managedSkillMarkerOwnsTarget(receipt))
				throw new Error(
					"refusing to replace an OpenClaw Skill without a matching Clawdi ownership receipt",
				);
			assertOfficialWorkspace(input);
			return withManagedTargetRollback({
				target,
				receipt: receipt.path,
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
							input.skillId,
							"--force",
						],
						input.home,
						input.home,
						{ timeoutMs: 120_000, maxBufferBytes: 1024 * 1024 },
					);
					if (result.status !== 0)
						throw new Error(
							`OpenClaw official Skill install failed: ${commandFailureDetail(result)}`,
						);
					assertOfficialWorkspace(input);
					writeManagedSkillReceipt(receipt);
					return "installed" as const;
				},
			});
		});
	},
	install(input) {
		if (
			managedSkillReceiptMatchesIdentity(
				receiptInput(input.workspaceRoot, input.skill.skillId, input.skill.sourceIdentity),
			)
		)
			return "unchanged";
		return withStagedManagedSkill(input.skill, (sourceDir) =>
			this.installDirectory({
				home: input.home,
				workspaceRoot: input.workspaceRoot,
				skillId: input.skill.skillId,
				sourceDir,
				ownershipIdentity: input.skill.sourceIdentity,
				previouslyReserved: input.previouslyReserved,
			}),
		);
	},
	anchorOwnership(input) {
		writeManagedSkillReceipt(
			receiptInput(input.workspaceRoot, input.skillId, input.ownershipIdentity),
		);
	},
	hasOwnershipReceipt(input) {
		return managedSkillMarkerMatchesIdentity(
			receiptInput(input.workspaceRoot, input.skillId, input.ownershipIdentity),
		);
	},
	verifyOwned(input) {
		return managedSkillReceiptMatchesIdentity(
			receiptInput(input.workspaceRoot, input.skill.skillId, input.skill.sourceIdentity),
		);
	},
	cleanupManifestOwned(input) {
		return withRuntimeUserFileAccess(() => {
			const target = targetDir(input.workspaceRoot, input.skillId);
			const receipt = receiptInput(input.workspaceRoot, input.skillId, input.ownershipIdentity);
			if (!existsSync(target)) {
				rmSync(receipt.path, { force: true });
				return "absent";
			}
			if (!managedSkillReceiptMatchesIdentity(receipt))
				throw new Error(
					"refusing manifest cleanup because OpenClaw Skill bytes no longer match the ownership receipt",
				);
			rmSync(target, { recursive: true });
			rmSync(receipt.path, { force: true });
			return "removed";
		});
	},
};
