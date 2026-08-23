import { resolve } from "node:path";
import {
	ManagedSkillResourceError,
	managedSkillTargetMatchesSource,
} from "./managed-skill-delivery";
import { replaceManagedSkillDirectoryAtomic } from "./managed-skill-reservation";

export function activateHostedHermesSkill(sourceDir: string, targetDir: string): void {
	const target = resolve(targetDir);
	replaceManagedSkillDirectoryAtomic(sourceDir, target, {
		afterActivate: () => {
			if (!managedSkillTargetMatchesSource(sourceDir, target)) {
				throw new ManagedSkillResourceError("Hermes Skill activation changed exact source bytes");
			}
		},
	});
}
