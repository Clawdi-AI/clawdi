import type { SkillTextDraft } from "../api/skill-content";
import { displayProjectName, type ProjectMetadata } from "./project-metadata";

export const skillFormCopy = {
	title: "Add skill",
	editTitle: "Edit skill",
	editDescription:
		"Saving updates this project skill. Linked agents receive the new version automatically, and imported support files stay attached.",
	name: "Skill name",
	namePlaceholder: "review-pull-requests",
	nameHelp: "Use lowercase letters, numbers, and single hyphens, such as review-pull-requests.",
	description: "Description",
	descriptionPlaceholder: "When and why an agent should use this skill",
	instructions: "Instructions",
	instructionsPlaceholder: "Explain what the agent should do, including constraints and examples.",
	cancel: "Cancel",
	adding: "Adding…",
	save: "Save",
	saving: "Saving…",
	transferDescription:
		"The destination gets an independent copy — later changes to the source won't sync.",
	transferAlternativeBefore: "To give people the ",
	transferAlternativeEmphasis: "same",
	transferAlternativeAfter: " skill, share the project instead.",
	destination: "Destination",
	chooseProject: "Choose a project…",
	copy: "Copy skill",
	move: "Move skill",
	sendFailed: "Couldn't copy or move skill",
} as const;

export function createSkillDescription(project: ProjectMetadata) {
	return `Add instructions to ${displayProjectName(project)}. Linked agents receive the skill automatically.`;
}

export function sendSkillTitle(name: string) {
	return `Copy or move ${name}`;
}

/** `sourceRemoved` is null for a copy and false when a move kept its source. */
export function sendSkillResult(
	sourceRemoved: boolean | null,
	skillName: string,
	targetLabel = "the destination",
) {
	return {
		title:
			sourceRemoved === true
				? "Skill moved"
				: sourceRemoved === false
					? "Skill copied, but not removed"
					: "Skill copied",
		description:
			`${skillName} is now available in ${targetLabel}.` +
			(sourceRemoved === false
				? " It couldn't be removed from the source; remove it after checking the new copy."
				: ""),
	};
}

export { skillRemovalDescription, skillRemovalTitle } from "./skill-transfer-dialog";

export function skillDraftUnchanged(draft: SkillTextDraft, original: SkillTextDraft) {
	return (
		draft.name === original.name &&
		draft.description === original.description &&
		draft.instructions.trim() === original.instructions.trim()
	);
}
