import type { components } from "@/lib/api-schemas";

type Schemas = components["schemas"];

export type ProjectInvitationNotification = Schemas["InvitationResponse"];
export type AcceptInvitationResponse = Schemas["InvitationAcceptResponse"];

export type AccountNotification = {
	id: string;
	title: string;
	description: string;
	category: string;
	createdAt: Date;
	read: boolean;
	actionLabel?: string;
	actionUrl?: string;
	severity: "info" | "warning" | "destructive";
};

const NOTIFICATION_ACTION_ORIGINS = new Set([
	"https://cloud.clawdi.ai",
	"https://clawdi.ai",
	"https://www.clawdi.ai",
]);

// Project invitations are the first notification source. Keep the shell named
// generically so future notification types (agent health, billing, access
// changes) can join without replacing the header affordance.
export const NOTIFICATION_CENTER_QUERY_KEY = ["get", "/v1/me/invitations"] as const;
export const NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS = [
	NOTIFICATION_CENTER_QUERY_KEY,
	["skills"],
	["get", "/v1/projects"],
	["get", "/v1/agents"],
] as const;

export function getPendingNotificationCount(
	notifications: readonly ProjectInvitationNotification[] | null | undefined,
	accountUnreadCount = 0,
): number {
	return (notifications?.length ?? 0) + accountUnreadCount;
}

export function resolveNotificationUrl(
	value: string,
	origin: string,
): { kind: "same-origin" | "external"; url: URL } | null {
	try {
		const base = new URL(origin);
		const url = new URL(value, base);
		if (url.origin === base.origin) return { kind: "same-origin", url };
		return NOTIFICATION_ACTION_ORIGINS.has(url.origin) ? { kind: "external", url } : null;
	} catch {
		return null;
	}
}

export function getNotificationCenterTriggerLabel(count: number): string {
	if (count === 1) return "Notifications, 1 new item";
	if (count > 1) return `Notifications, ${count} new items`;
	return "Notifications";
}

export function getNotificationCenterEmptyCopy(): {
	title: string;
	description: string;
} {
	return {
		title: "No notifications yet",
		description: "Account updates and project invitations will appear here.",
	};
}

export function getNotificationCenterDescription(): string {
	return "Account activity and project invitations.";
}

export function getProjectInvitationAccessCopy(): string {
	return "View shared projects and link them to your agents. Only the owner can edit.";
}

export function getAcceptedProjectInvitationToastCopy(projectName?: string): {
	title: string;
	description: string;
} {
	return {
		title: projectName ? `Joined ${projectName}` : "Project joined",
		description: "Open the project to view its resources or link it to an agent.",
	};
}
