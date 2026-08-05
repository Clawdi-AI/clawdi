import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

function commandPath(home: string): string {
	for (const candidate of [
		join(home, ".local", "bin", "openclaw"),
		join(home, ".openclaw", "bin", "openclaw"),
	])
		if (executableExists(candidate)) return candidate;
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

function assertOfficialWorkspace(input: { home: string; workspaceRoot: string }): void {
	const result = spawnRuntimeUserCommand(
		commandPath(input.home),
		["agents", "list", "--json"],
		input.home,
		input.workspaceRoot,
		{ timeoutMs: 15_000, maxBufferBytes: 1024 * 1024 },
	);
	if (result.status !== 0)
		throw new Error("OpenClaw official agent workspace roster is unavailable");
	let roster: unknown;
	try {
		roster = JSON.parse(String(result.stdout));
	} catch {
		throw new Error("OpenClaw official agent workspace roster is malformed");
	}
	if (!Array.isArray(roster))
		throw new Error("OpenClaw official agent workspace roster is malformed");
	const main = roster.filter((entry): entry is Record<string, unknown> =>
		Boolean(
			entry &&
				typeof entry === "object" &&
				!Array.isArray(entry) &&
				(entry as Record<string, unknown>).id === OPENCLAW_AGENT_ID,
		),
	);
	if (main.length !== 1 || typeof main[0].workspace !== "string" || !isAbsolute(main[0].workspace))
		throw new Error("OpenClaw official agent workspace roster is malformed");
	if (resolve(main[0].workspace) !== resolve(input.workspaceRoot))
		throw new Error(
			"OpenClaw official agent workspace does not match the desired manifest workspace",
		);
}

function nativeResultMatches(sourceDir: string, target: string): boolean {
	return managedSkillTreesEqual(
		collectManagedSkillTree(sourceDir),
		collectManagedSkillTree(target, { exclude: EXCLUDED_NATIVE_FILES }),
	);
}

export const hostedOpenClawSkillDriver: HostedOpenClawSkillDriver = {
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
