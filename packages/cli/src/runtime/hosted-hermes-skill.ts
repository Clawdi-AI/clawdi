import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import {
	collectManagedSkillTree,
	collectRuntimeUserManagedSkillTree,
	HERMES_MANAGED_SKILL_RECEIPT_SCHEMA,
	ManagedSkillResourceError,
	managedSkillMarkerMatchesIdentity,
	managedSkillReceiptIdentityState,
	managedSkillReceiptMatchesIdentity,
	managedSkillReceiptPath,
	managedSkillTreesEqual,
	withStagedManagedSkill,
	writeManagedSkillReceipt,
} from "./managed-skill-delivery";
import { replaceManagedSkillDirectoryAtomic } from "./managed-skill-reservation";
import { withRuntimeUserFileAccess } from "./runtime-user-command";

export interface HostedHermesSkillExactSourceDriver {
	target?(input: { home: string; skill: PreparedHostedSourcedSkill }): string;
	install(input: {
		home: string;
		appRoot: string;
		managedResourceRoot: string;
		skill: PreparedHostedSourcedSkill;
		targetDir?: string;
		previouslyReserved: boolean;
	}): "installed" | "unchanged";
	anchorOwnership(input: {
		home: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
		targetDir?: string;
	}): void;
	verifyOwned(input: {
		home: string;
		appRoot: string;
		managedResourceRoot: string;
		skill: PreparedHostedSourcedSkill;
		targetDir?: string;
	}): boolean;
	hasOwnershipReceipt(input: {
		home: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
		targetDir?: string;
	}): boolean;
	uninstall(input: {
		home: string;
		appRoot: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
		targetDir?: string;
	}): "absent" | "removed";
	cleanupManifestOwned(input: {
		home: string;
		managedResourceRoot: string;
		skillId: string;
		ownershipIdentity: string;
		targetDir?: string;
	}): "absent" | "removed";
}

function targetDir(home: string, skillId: string): string {
	// Hermes a77ee88 discovers profile-local Skills here without invoking the
	// hub install guard. Revisit if upstream starts guarding this path
	// (NousResearch/hermes-agent#89704, Clawdi-AI/clawdi#1148).
	return join(home, ".hermes", "skills", skillId);
}

function receiptInput(
	managedResourceRoot: string,
	skillId: string,
	ownershipIdentity: string,
	target: string,
) {
	return {
		path: managedSkillReceiptPath(managedResourceRoot, "hermes", skillId),
		managedResourceRoot,
		schemaVersion: HERMES_MANAGED_SKILL_RECEIPT_SCHEMA,
		skillId,
		ownershipIdentity,
		target,
	};
}

function assertActivationMatchesSource(sourceDir: string, target: string): void {
	const source = collectManagedSkillTree(sourceDir);
	const installed = collectRuntimeUserManagedSkillTree(target);
	if (source.status !== "collected") {
		throw new Error(`prepared Hermes Skill tree is ${source.status}`);
	}
	if (installed.status !== "collected") {
		throw new ManagedSkillResourceError(`installed Hermes Skill tree is ${installed.status}`);
	}
	if (!managedSkillTreesEqual(source.tree, installed.tree)) {
		throw new ManagedSkillResourceError("Hermes Skill activation changed exact source bytes");
	}
}

function removeOwnedSkill(input: {
	home: string;
	managedResourceRoot: string;
	skillId: string;
	ownershipIdentity: string;
	targetDir?: string;
}): "absent" | "removed" {
	const target = resolve(input.targetDir ?? targetDir(input.home, input.skillId));
	const receipt = receiptInput(
		input.managedResourceRoot,
		input.skillId,
		input.ownershipIdentity,
		target,
	);
	const receiptState = managedSkillReceiptIdentityState(receipt);
	if (receiptState === "absent") {
		rmSync(receipt.path, { force: true });
		return "absent";
	}
	if (receiptState === "unsafe") throw new Error("Hermes Skill tree is unsafe");
	if (receiptState !== "matched") {
		throw new Error("Hermes Skill bytes no longer match the manifest ownership receipt");
	}
	withRuntimeUserFileAccess(() => {
		rmSync(target, { recursive: true });
	});
	rmSync(receipt.path, { force: true });
	return "removed";
}

export const hostedHermesSkillExactSourceDriver: HostedHermesSkillExactSourceDriver = {
	target(input) {
		return targetDir(input.home, input.skill.skillId);
	},
	install(input) {
		const target = resolve(input.targetDir ?? targetDir(input.home, input.skill.skillId));
		const receipt = receiptInput(
			input.managedResourceRoot,
			input.skill.skillId,
			input.skill.sourceIdentity,
			target,
		);
		if (withRuntimeUserFileAccess(() => existsSync(target)) && !input.previouslyReserved) {
			throw new Error("Hermes Skill target is not paired with a manifest reservation");
		}
		if (managedSkillReceiptMatchesIdentity(receipt)) return "unchanged";
		return withStagedManagedSkill(input.skill, (sourceDir) => {
			replaceManagedSkillDirectoryAtomic(sourceDir, target, {
				receipt: receipt.path,
				afterActivate: () => {
					assertActivationMatchesSource(sourceDir, target);
					writeManagedSkillReceipt(receipt);
				},
			});
			return "installed" as const;
		});
	},
	anchorOwnership(input) {
		writeManagedSkillReceipt(
			receiptInput(
				input.managedResourceRoot,
				input.skillId,
				input.ownershipIdentity,
				input.targetDir ?? targetDir(input.home, input.skillId),
			),
		);
	},
	verifyOwned(input) {
		return managedSkillReceiptMatchesIdentity(
			receiptInput(
				input.managedResourceRoot,
				input.skill.skillId,
				input.skill.sourceIdentity,
				input.targetDir ?? targetDir(input.home, input.skill.skillId),
			),
		);
	},
	hasOwnershipReceipt(input) {
		return managedSkillMarkerMatchesIdentity(
			receiptInput(
				input.managedResourceRoot,
				input.skillId,
				input.ownershipIdentity,
				input.targetDir ?? targetDir(input.home, input.skillId),
			),
		);
	},
	uninstall(input) {
		return removeOwnedSkill(input);
	},
	cleanupManifestOwned(input) {
		return removeOwnedSkill(input);
	},
};
