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

export type NotificationCenterView = "all" | "unread";

const NOTIFICATION_ACTION_ORIGINS = new Set(["https://cloud.clawdi.ai", "https://www.clawdi.ai"]);

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

export function filterAccountNotifications(
	notifications: readonly AccountNotification[],
	view: NotificationCenterView,
): readonly AccountNotification[] {
	return view === "unread"
		? notifications.filter((notification) => !notification.read)
		: notifications;
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

export function getNotificationCenterEmptyCopy(view: NotificationCenterView): {
	title: string;
	description: string;
} {
	return view === "unread"
		? {
				title: "You're all caught up",
				description: "New account updates and project invitations will appear here.",
			}
		: {
				title: "No notifications yet",
				description: "Account updates and project invitations will appear here.",
			};
}

export function getNotificationCenterDescription(): string {
	return "Account activity and project invitations.";
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
			"Read-only access granted. Open the Project to review shared resources, then link it to an Agent when needed.",
	};
}
