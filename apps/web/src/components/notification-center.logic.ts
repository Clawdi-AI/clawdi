import type { components } from "@/lib/api-schemas";

type Schemas = components["schemas"];

export type ProjectInvitationNotification = Schemas["InvitationResponse"];
export type AcceptInvitationResponse = Schemas["InvitationAcceptResponse"];

// Project invitations are the first notification source. Keep the shell named
// generically so future notification types (agent health, billing, access
// changes) can join without replacing the header affordance.
export const NOTIFICATION_CENTER_QUERY_KEY = ["me-invitations"] as const;
export const NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS = [
	NOTIFICATION_CENTER_QUERY_KEY,
	["skills"],
	["projects"],
	["agents"],
] as const;

export function getPendingNotificationCount(
	notifications: readonly ProjectInvitationNotification[] | null | undefined,
): number {
	return notifications?.length ?? 0;
}

export function getNotificationCenterTriggerLabel(count: number): string {
	if (count === 1) return "Notification Center, 1 Pending Invitation";
	if (count > 1) return `Notification Center, ${count} Pending Invitations`;
	return "Notification Center";
}

export function getNotificationCenterTitle(count: number): string {
	if (count === 1) return "1 Pending Notification";
	if (count > 1) return `${count} Pending Notifications`;
	return "Notification Center";
}

export function getNotificationCenterEmptyCopy(): { title: string; description: string } {
	return {
		title: "No Pending Notifications",
		description:
			"Project invitations and other action-required updates will appear here under the top-right Notification Center bell.",
	};
}

export function getProjectInvitationAccessCopy(): string {
	return "Project invitations give read-only access (view, not edit). Adding the Project to an agent is a separate step.";
}

export function getAcceptedProjectInvitationToastCopy(projectName?: string): {
	title: string;
	description: string;
} {
	return {
		title: projectName ? `Joined ${projectName}` : "Project Joined",
		description:
			"Read-only access granted. Open the Project to review shared resources, then add it to an agent when needed.",
	};
}
