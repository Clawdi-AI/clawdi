import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	type OpenClawAgentWorkspace,
	parseOpenClawAgentWorkspaces,
} from "../adapters/openclaw-workspace";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import {
	collectManagedSkillTree,
	managedSkillReceiptMatchesIdentity,
	managedSkillReceiptOwnsTarget,
	managedSkillTreesEqual,
	withManagedTargetRollback,
	withStagedManagedSkill,
	writeManagedSkillReceipt,
} from "./managed-skill-delivery";
import { executableExists, spawnRuntimeUserCommand } from "./runtime-user-command";

const OPENCLAW_AGENT_ID = "main";
const SOURCE_RECEIPT = ".openclaw/source-origin.json";
const EXCLUDED_NATIVE_FILES = new Set([SOURCE_RECEIPT]);
const RECEIPT_SCHEMA = "clawdi.openclawManifestSkillReceipt.v2";

export interface HostedOpenClawSkillDriver {
	resolveWorkspace(input: { home: string }): string;
	installDirectory(input: {
		home: string;
		workspaceRoot: string;
		skillId: string;
		sourceDir: string;
		ownershipIdentity: string;
	}): "installed" | "unchanged";
	install(input: {
		home: string;
		workspaceRoot: string;
		skill: PreparedHostedSourcedSkill;
	}): "installed" | "unchanged";
	verifyOwned(input: { workspaceRoot: string; skill: PreparedHostedSourcedSkill }): boolean;
	cleanupManifestOwned(input: {
		workspaceRoot: string;
		skillId: string;
		ownershipIdentity: string;
	}): "absent" | "removed";
}

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

function resolveOfficialWorkspace(home: string): string {
	const command = commandPath(home);
	const result = spawnRuntimeUserCommand(command, ["agents", "list", "--json"], home, home, {
		timeoutMs: 15_000,
		maxBufferBytes: 1024 * 1024,
	});
	if (result.status !== 0)
		throw new Error("OpenClaw official agent workspace roster is unavailable");
	let roster: OpenClawAgentWorkspace[];
	try {
		roster = parseOpenClawAgentWorkspaces(String(result.stdout));
	} catch {
		throw new Error("OpenClaw official agent workspace roster is malformed");
	}
	const main = roster.filter((entry) => entry.id === OPENCLAW_AGENT_ID);
	if (main.length !== 1 || !isAbsolute(main[0].workspace))
		throw new Error("OpenClaw official agent workspace roster is malformed");
	return resolve(main[0].workspace);
}

function assertOfficialWorkspace(input: { home: string; workspaceRoot: string }): void {
	if (resolveOfficialWorkspace(input.home) !== resolve(input.workspaceRoot))
		throw new Error("OpenClaw official agent workspace changed during Skill reconciliation");
}

function nativeResultMatches(sourceDir: string, target: string): boolean {
	return managedSkillTreesEqual(
		collectManagedSkillTree(sourceDir),
		collectManagedSkillTree(target, { exclude: EXCLUDED_NATIVE_FILES }),
	);
}

export const hostedOpenClawSkillDriver: HostedOpenClawSkillDriver = {
	resolveWorkspace(input) {
		return resolveOfficialWorkspace(input.home);
	},
	installDirectory(input) {
		const target = targetDir(input.workspaceRoot, input.skillId);
		const receipt = receiptInput(input.workspaceRoot, input.skillId, input.ownershipIdentity);
		if (nativeResultMatches(input.sourceDir, target) && managedSkillReceiptMatchesIdentity(receipt))
			return "unchanged";
		if (existsSync(target) && !managedSkillReceiptOwnsTarget(receipt))
			throw new Error(
				"refusing to replace an OpenClaw Skill without a matching Clawdi ownership receipt",
			);
		assertOfficialWorkspace(input);
		return withManagedTargetRollback({
			target,
			receipt: receipt.path,
			operation: () => {
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
					input.workspaceRoot,
					{ timeoutMs: 120_000, maxBufferBytes: 1024 * 1024 },
				);
				if (result.status !== 0)
					throw new Error(
						`OpenClaw official Skill install failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`,
					);
				if (!nativeResultMatches(input.sourceDir, target))
					throw new Error(
						`OpenClaw installed Skill outside the configured agent workspace or changed exact source bytes: ${target}`,
					);
				assertOfficialWorkspace(input);
				writeManagedSkillReceipt(receipt);
				return "installed" as const;
			},
		});
	},
	install(input) {
		return withStagedManagedSkill(input.skill, (sourceDir) =>
			this.installDirectory({
				home: input.home,
				workspaceRoot: input.workspaceRoot,
				skillId: input.skill.skillId,
				sourceDir,
				ownershipIdentity: input.skill.sourceIdentity,
			}),
		);
	},
	verifyOwned(input) {
		return withStagedManagedSkill(
			input.skill,
			(sourceDir) =>
				nativeResultMatches(sourceDir, targetDir(input.workspaceRoot, input.skill.skillId)) &&
				managedSkillReceiptMatchesIdentity(
					receiptInput(input.workspaceRoot, input.skill.skillId, input.skill.sourceIdentity),
				),
		);
	},
	cleanupManifestOwned(input) {
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
	},
};
