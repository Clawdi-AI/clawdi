export interface CollaborationInvitation {
	id: string;
	project_id: string;
	project_name: string;
	project_kind: string;
	owner_display: string;
	owner_handle: string;
	invitee_email: string;
	invited_by_user_id: string;
	invited_by_display: string | null;
	created_at: string;
}

export interface AcceptInvitationResponse {
	id: string;
	project_id: string;
	role: string;
	joined_via: string;
	joined_at: string;
	resolved_owner_handle: string;
	bound_agent_ids?: string[];
}

export const COLLABORATION_INBOX_QUERY_KEY = ["me-invitations"] as const;
export const COLLABORATION_MEMBERSHIP_QUERY_KEYS = [
	COLLABORATION_INBOX_QUERY_KEY,
	["skills"],
	["projects"],
	["agents"],
] as const;

export function getPendingInvitationCount(
	invitations: readonly CollaborationInvitation[] | null | undefined,
): number {
	return invitations?.length ?? 0;
}

export function getCollaborationInboxTriggerLabel(count: number): string {
	if (count === 1) return "Collaboration inbox, 1 pending invitation";
	if (count > 1) return `Collaboration inbox, ${count} pending invitations`;
	return "Collaboration inbox";
}

export function getCollaborationInboxTitle(count: number): string {
	if (count === 1) return "1 pending invitation";
	if (count > 1) return `${count} pending invitations`;
	return "Collaboration inbox";
}

export function getCollaborationInboxEmptyCopy(): { title: string; description: string } {
	return {
		title: "No pending invitations",
		description: "Project invitations from collaborators will appear here.",
	};
}

export function getInvitationAccessCopy(): string {
	return "Accepting grants read-only viewer Project access. Use with agent is a separate explicit step.";
}

export function getAcceptedInvitationToastCopy(projectName?: string): {
	title: string;
	description: string;
} {
	return {
		title: projectName ? `Joined ${projectName}` : "Project joined",
		description:
			"read-only viewer Project access granted. Open project to review it, then Use with agent as a separate explicit step.",
	};
}
