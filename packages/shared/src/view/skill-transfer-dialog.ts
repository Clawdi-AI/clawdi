export const SKILL_TRANSFER_COPY = {
	description:
		"The destination gets an independent copy — later changes to the source won't sync. To give people the same skill, share the project instead.",
	descriptionBefore:
		"The destination gets an independent copy — later changes to the source won't sync. To give people the",
	descriptionSame: "same",
	descriptionAfter: "skill, share the project instead.",
	destination: "Destination",
	chooseProject: "Choose a project…",
	copy: "Copy skill",
	move: "Move skill",
	partial:
		"Skill copied, but not removed. It could not be removed from the source; remove it after checking the new copy.",
};
export function skillTransferTitle(name: string) {
	return `Copy or move ${name}`;
}
export function skillRemovalTitle(name: string) {
	return `Remove ${name} from project?`;
}
export function skillRemovalDescription(projectName?: string | null) {
	return `Every agent using ${projectName || "this project"} loses this skill. Other projects keep their copies.`;
}
