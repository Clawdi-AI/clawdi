import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import {
	collectManagedSkillTree,
	collectRuntimeUserManagedSkillTree,
	HERMES_MANAGED_SKILL_RECEIPT_SCHEMA,
	ManagedSkillResourceError,
	managedSkillMarkerMatchesIdentity,
	managedSkillReceiptMatchesIdentity,
	managedSkillReceiptPath,
	managedSkillTreesEqual,
	withManagedTargetRollback,
	withStagedManagedSkill,
	writeManagedSkillReceipt,
} from "./managed-skill-delivery";
import { replaceManagedSkillDirectoryAtomic } from "./managed-skill-reservation";
import {
	executableExists,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";

export interface HostedHermesSkillExactSourceDriver {
	install(input: {
		home: string;
		appRoot: string;
		managedResourceRoot: string;
		skill: PreparedHostedSourcedSkill;
		previouslyReserved: boolean;
	}): "installed" | "unchanged";
	anchorOwnership(input: {
		home: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
	}): void;
	verifyOwned(input: {
		home: string;
		appRoot: string;
		managedResourceRoot: string;
		skill: PreparedHostedSourcedSkill;
	}): boolean;
	hasOwnershipReceipt(input: {
		home: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
	}): boolean;
	uninstall(input: {
		home: string;
		appRoot: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
	}): "absent" | "removed";
	cleanupManifestOwned(input: {
		home: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
	}): "absent" | "removed";
}

function commandPath(home: string, appRoot: string): string {
	return withRuntimeUserFileAccess(() => {
		for (const candidate of [
			join(appRoot, "venv", "bin", "hermes"),
			join(home, ".local", "bin", "hermes"),
		])
			if (executableExists(candidate)) return candidate;
		throw new Error("installed Hermes Skill CLI is unavailable");
	});
}
const targetDir = (home: string, skillId: string) => join(home, ".hermes", "skills", skillId);

function receiptInput(
	managedResourceRoot: string,
	home: string,
	skillId: string,
	ownershipIdentity: string,
) {
	return {
		path: managedSkillReceiptPath(managedResourceRoot, "hermes", skillId),
		managedResourceRoot,
		schemaVersion: HERMES_MANAGED_SKILL_RECEIPT_SCHEMA,
		skillId,
		ownershipIdentity,
		target: targetDir(home, skillId),
	};
}

function rawSkillUrl(skill: PreparedHostedSourcedSkill): string {
	if (skill.source.type === "project") return skill.source.installUrl;
	if (skill.source.type === "bundled") {
		throw new Error("bundled Hermes Skills do not have a remote install URL");
	}
	const repository = new URL(skill.source.url);
	const [owner, repo] = repository.pathname.slice(1).split("/");
	if (!owner || !repo)
		throw new Error("Hermes exact-source URL requires a canonical GitHub repository");
	const encodedPath = skill.source.path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	const skillPath = encodedPath ? `${encodedPath}/SKILL.md` : "SKILL.md";
	return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${skill.source.commit}/${skillPath}`;
}

function runHermes(input: { home: string; appRoot: string }, args: string[], stdin?: string) {
	return spawnRuntimeUserCommand(
		commandPath(input.home, input.appRoot),
		args,
		input.home,
		input.appRoot,
		{
			input: stdin,
			timeoutMs: 120_000,
			maxBufferBytes: 1024 * 1024,
		},
	);
}

function runHermesUninstall(input: { home: string; appRoot: string }, skillId: string) {
	// Hermes exposes no --yes flag for this subcommand; its confirmation reads stdin.
	return runHermes(input, ["skills", "uninstall", skillId], "y\n");
}

function bundledResultMatches(sourceDir: string, target: string): boolean {
	return managedSkillTreesEqual(
		collectManagedSkillTree(sourceDir),
		collectRuntimeUserManagedSkillTree(target),
	);
}

export const hostedHermesSkillExactSourceDriver: HostedHermesSkillExactSourceDriver = {
	install(input) {
		const target = targetDir(input.home, input.skill.skillId);
		const receipt = receiptInput(
			input.managedResourceRoot,
			input.home,
			input.skill.skillId,
			input.skill.sourceIdentity,
		);
		if (withRuntimeUserFileAccess(() => existsSync(target)) && !input.previouslyReserved)
			throw new Error("Hermes Skill target is not paired with a manifest reservation");
		if (managedSkillReceiptMatchesIdentity(receipt)) return "unchanged";
		return withStagedManagedSkill(input.skill, (sourceDir) =>
			withManagedTargetRollback({
				target,
				receipt: receipt.path,
				operation: () => {
					if (input.skill.source.type === "bundled") {
						withRuntimeUserFileAccess(() => replaceManagedSkillDirectoryAtomic(sourceDir, target));
						if (!bundledResultMatches(sourceDir, target)) {
							throw new ManagedSkillResourceError(
								"Hermes bundled Skill activation changed exact source bytes",
							);
						}
						writeManagedSkillReceipt(receipt);
						return "installed" as const;
					}
					const args = [
						"skills",
						"install",
						rawSkillUrl(input.skill),
						"--name",
						input.skill.skillId,
						"--yes",
					];
					if (input.previouslyReserved) args.push("--force");
					const result = runHermes(input, args);
					if (result.status !== 0)
						throw new ManagedSkillResourceError(
							`Hermes official Skill install failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`,
						);
					writeManagedSkillReceipt(receipt);
					return "installed" as const;
				},
			}),
		);
	},
	anchorOwnership(input) {
		writeManagedSkillReceipt(
			receiptInput(input.managedResourceRoot, input.home, input.skillId, input.ownershipIdentity),
		);
	},
	verifyOwned(input) {
		return managedSkillReceiptMatchesIdentity(
			receiptInput(
				input.managedResourceRoot,
				input.home,
				input.skill.skillId,
				input.skill.sourceIdentity,
			),
		);
	},
	hasOwnershipReceipt(input) {
		return managedSkillMarkerMatchesIdentity(
			receiptInput(input.managedResourceRoot, input.home, input.skillId, input.ownershipIdentity),
		);
	},
	uninstall(input) {
		const target = targetDir(input.home, input.skillId);
		const receipt = receiptInput(
			input.managedResourceRoot,
			input.home,
			input.skillId,
			input.ownershipIdentity,
		);
		if (!withRuntimeUserFileAccess(() => existsSync(target))) {
			rmSync(receipt.path, { force: true });
			return "absent";
		}
		if (!managedSkillReceiptMatchesIdentity(receipt))
			throw new Error("Hermes Skill bytes no longer match the manifest ownership receipt");
		const result = runHermesUninstall(input, input.skillId);
		if (result.status !== 0)
			throw new ManagedSkillResourceError(
				`Hermes official Skill uninstall failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`,
			);
		if (withRuntimeUserFileAccess(() => existsSync(target)))
			throw new ManagedSkillResourceError(
				"Hermes official Skill uninstall did not remove the Skill target",
			);
		rmSync(receipt.path, { force: true });
		return "removed";
	},
	cleanupManifestOwned(input) {
		const target = targetDir(input.home, input.skillId);
		const receipt = receiptInput(
			input.managedResourceRoot,
			input.home,
			input.skillId,
			input.ownershipIdentity,
		);
		if (!withRuntimeUserFileAccess(() => existsSync(target))) {
			rmSync(receipt.path, { force: true });
			return "absent";
		}
		if (!managedSkillReceiptMatchesIdentity(receipt)) {
			throw new Error("Hermes Skill bytes no longer match the manifest ownership receipt");
		}
		withRuntimeUserFileAccess(() => {
			rmSync(target, { recursive: true });
		});
		rmSync(receipt.path, { force: true });
		return "removed";
	},
};
