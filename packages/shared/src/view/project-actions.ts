export const PROJECT_ACTION_COPY = {
	share: "Share",
	archive: "Archive",
	editDescription: "Update its name and description without leaving this page.",
	archiveDescription:
		"Agents will stop using this Project's Skills and Vaults. The Project will disappear from your library.",
	archiveConfirm: "Archive project",
};
export function projectArchiveTitle(name: string) {
	return `Archive ${name}?`;
}
