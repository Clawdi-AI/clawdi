import { join, resolve } from "node:path";
import type { PreparedHostedSourcedSkill } from "./hosted-sourced-skill-archive";
import {
	ManagedSkillResourceError,
	managedSkillTargetMatchesSource,
	withStagedManagedSkill,
} from "./managed-skill-delivery";
import { replaceManagedSkillDirectoryAtomic } from "./managed-skill-reservation";

export interface HostedHermesSkillExactSourceDriver {
	target(input: { home: string; skill: PreparedHostedSourcedSkill }): string;
	install(input: {
		home: string;
		skill: PreparedHostedSourcedSkill;
		targetDir: string;
	}): "installed" | "unchanged";
}

function targetDir(home: string, skillId: string): string {
	// Hermes a77ee88 discovers profile-local Skills here without invoking the
	// hub install guard. Revisit if upstream starts guarding this path
	// (NousResearch/hermes-agent#89704, Clawdi-AI/clawdi#1148).
	return join(home, ".hermes", "skills", skillId);
}

function assertActivationMatchesSource(sourceDir: string, target: string): void {
	if (!managedSkillTargetMatchesSource(sourceDir, target)) {
		throw new ManagedSkillResourceError("Hermes Skill activation changed exact source bytes");
	}
}

export const hostedHermesSkillExactSourceDriver: HostedHermesSkillExactSourceDriver = {
	target(input) {
		return targetDir(input.home, input.skill.skillId);
	},
	install(input) {
		const target = resolve(input.targetDir);
		return withStagedManagedSkill(input.skill, (sourceDir) => {
			replaceManagedSkillDirectoryAtomic(sourceDir, target, {
				afterActivate: () => assertActivationMatchesSource(sourceDir, target),
			});
			return "installed" as const;
		});
	},
};
