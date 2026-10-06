import type { SkillTextDraft } from "../api/skill-content";
import { displayProjectName, type ProjectMetadata } from "./project-metadata";

export const skillFormCopy = {
	title: "Add skill",
	editTitle: "Edit skill",
	editDescription:
		"Saving updates this Project Skill. Linked Agents receive the new version automatically, and imported support files stay attached.",
	name: "Skill name",
	namePlaceholder: "review-pull-requests",
	nameHelp: "Use lowercase letters, numbers, and single hyphens, such as review-pull-requests.",
	description: "Description",
	descriptionPlaceholder: "When and why an Agent should use this Skill",
	instructions: "Instructions",
	instructionsPlaceholder: "Explain what the Agent should do, including constraints and examples.",
	cancel: "Cancel",
	adding: "Adding…",
	save: "Save",
	saving: "Saving…",
	transferDescription:
		"The destination gets an independent copy — later changes to the source won't sync.",
	transferAlternativeBefore: "To give people the ",
	transferAlternativeEmphasis: "same",
	transferAlternativeAfter: " Skill, share the Project instead.",
	destination: "Destination",
	chooseProject: "Choose a Project…",
	copy: "Copy skill",
	move: "Move skill",
} as const;

export function createSkillDescription(project: ProjectMetadata) {
	return `Add instructions to ${displayProjectName(project)}. Linked Agents receive the Skill automatically.`;
}

export function sendSkillTitle(name: string) {
	return `Copy or move ${name}`;
}

export { skillRemovalDescription, skillRemovalTitle } from "./skill-transfer-dialog";

export function skillDraftUnchanged(draft: SkillTextDraft, original: SkillTextDraft) {
	return (
		draft.name === original.name &&
		draft.description === original.description &&
		draft.instructions.trim() === original.instructions.trim()
	);
}
