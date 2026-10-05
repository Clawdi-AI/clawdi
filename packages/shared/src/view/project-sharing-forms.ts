export const projectSharingFormCopy = {
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
		"All invite links and pending invitations will stop working. Members will lose access. Your Project content stays unchanged.",
	keepSharing: "Keep sharing",
	cancel: "Cancel",
} as const;

export function canceledInvitationDescription(email: string) {
	return `${email} will no longer see this invitation in their dashboard.`;
}

export function removedMemberDescription(label: string) {
	return `${label} will lose access to this Project.`;
}

export function formatMembershipToken(value: string) {
	return value
		.split(/[_-]+/g)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}
