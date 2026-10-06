export const projectSharingFormCopy = {
	leave: "Leave project",
	leaveDescription:
		"This removes your access and unlinks the project from your agents. Those agents will stop using its skills and vaults.",
	archiveDescription:
		"Agents will stop using this project's skills and vaults. The project will disappear from your library.",
	archive: "Archive project",
	revokeTitle: "Turn off this invite link?",
	revokeDescription:
		"People will no longer be able to join from this link. Existing members retain access until removed from People.",
	revoke: "Turn off link",
	cancelTitle: "Cancel this invitation?",
	keepInvitation: "Keep invitation",
	cancelInvitation: "Cancel invitation",
	removeTitle: "Remove this member?",
	removeMember: "Remove member",
	stopTitle: "Stop all sharing?",
	stopDescription:
		"All invite links and pending invitations will stop working. Members will lose access. Your project content stays unchanged.",
	keepSharing: "Keep sharing",
	cancel: "Cancel",
} as const;

export function canceledInvitationDescription(email: string) {
	return `${email} will no longer see this invitation in their dashboard.`;
}

export function removedMemberDescription(label: string) {
	return `${label} will lose access to this project.`;
}

export function formatMembershipToken(value: string) {
	return value
		.split(/[_-]+/g)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function archiveProjectTitle(name: string) {
	return `Archive ${name}?`;
}

export function leaveProjectTitle(name: string) {
	return `Leave ${name}?`;
}

export const projectInvitationCopy = {
	title: "Project invitation",
	sharedBy: "Shared by ",
	accept: "Accept invitation",
	joining: "Joining…",
};
export function projectInvitationCounts(skills: number, vaults: number) {
	return `${skills} ${skills === 1 ? "Skill" : "Skills"} · ${vaults} ${vaults === 1 ? "Vault" : "Vaults"}`;
}
export function projectInvitationAccess(hasVaults: boolean) {
	return (
		"You can view this project and link it to your agents. Only the owner can edit." +
		(hasVaults
			? " Your agents and the Clawdi CLI can use its keys; secret values stay hidden in the dashboard."
			: "")
	);
}
