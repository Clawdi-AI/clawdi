export const SKILL_TRANSFER_COPY = {
	description:
		"The destination gets an independent copy — later changes to the source won't sync. To give people the same Skill, share the Project instead.",
	descriptionBefore:
		"The destination gets an independent copy — later changes to the source won't sync. To give people the",
	descriptionSame: "same",
	descriptionAfter: "Skill, share the Project instead.",
	destination: "Destination",
	chooseProject: "Choose a Project…",
	copy: "Copy skill",
	move: "Move skill",
	partial:
		"Skill copied, but not removed. It could not be removed from the source; remove it after checking the new copy.",
};
export function skillTransferTitle(name: string) {
	return `Copy or move ${name}`;
}
export function skillRemovalTitle(name: string) {
	return `Remove ${name} from Project?`;
}
export function skillRemovalDescription(projectName?: string | null) {
	return `Every Agent using ${projectName || "this Project"} loses this Skill. Other Projects keep their copies.`;
}
