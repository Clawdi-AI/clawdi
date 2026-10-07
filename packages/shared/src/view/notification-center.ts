import type { components as DeployComponents } from "../api/deploy.generated";

type ApiNotification = DeployComponents["schemas"]["AccountNotificationResponse"];
export type AccountNotificationPage =
	DeployComponents["schemas"]["AccountNotificationListResponse"];

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

export const ACCOUNT_NOTIFICATIONS_PAGE_SIZE = 50;

/** Copy for the notification center on Web and mobile. */
export const notificationCenterCopy = {
	title: "Notifications",
	accountSection: "Account updates",
	invitationsSection: "Project invitations",
	loadingAccount: "Loading account updates…",
	accountUnavailableTitle: "Account updates unavailable",
	accountUnavailableDescription:
		"We couldn't load account updates. Check your connection and try again.",
	loadingInvitations: "Loading project invitations…",
	invitationsUnavailableTitle: "Project invitations unavailable",
	retry: "Retry",
	loadEarlier: "Load earlier",
	remove: "Remove",
	removeFailed: "Couldn't remove notification",
	invalidLink: "This notification link is invalid",
	openFailed: "Couldn't open notification link",
	newSuffix: " (new)",
	viewer: "Viewer",
	accept: "Accept",
	accepting: "Joining…",
	decline: "Decline",
	declining: "Declining…",
	declined: "Invitation declined",
	declineFailed: "Couldn't decline invitation",
	invitationCanceled: "This invitation was canceled. Ask the owner to send a new one.",
	openProject: "Open project",
	moreActions: (title: string) => `More actions for ${title}`,
	from: (ownerDisplay: string) => `From ${ownerDisplay}`,
} as const;

/** The hosted Web dashboard: its URLs are in-app routes in the Clawdi apps. */
export const NOTIFICATION_APP_ORIGIN = "https://cloud.clawdi.ai";

const NOTIFICATION_ACTION_ORIGINS = new Set([
	NOTIFICATION_APP_ORIGIN,
	"https://clawdi.ai",
	"https://www.clawdi.ai",
]);

export function toAccountNotification(item: ApiNotification): AccountNotification {
	return {
		id: item.id,
		title: item.title,
		description: item.description,
		category: item.category,
		createdAt: new Date(item.created_at),
		read: item.read_at != null,
		actionLabel: item.action_label ?? undefined,
		actionUrl: item.action_url ?? undefined,
		severity: item.severity,
	};
}

/** Pages can overlap while new notifications arrive; the first occurrence's position wins. */
export function accountNotificationsFromPages(
	pages: readonly AccountNotificationPage[] | undefined,
): AccountNotification[] {
	const unique = new Map<string, AccountNotification>();
	for (const item of pages?.flatMap((page) => page.items) ?? []) {
		unique.set(item.id, toAccountNotification(item));
	}
	return [...unique.values()];
}

/**
 * The newest notification to mark seen when the open center has settled on unread items.
 * Opening the center marks everything up to the newest item read (`read-all` with `up_to_id`).
 */
export function notificationToMarkSeen(
	firstPage: AccountNotificationPage | undefined,
	lastMarkedNewestId: string | null,
): string | null {
	if (!firstPage || firstPage.unread_count <= 0 || firstPage.items.length === 0) return null;
	const newest = firstPage.items[0];
	return newest && newest.id !== lastMarkedNewestId ? newest.id : null;
}

/** Unread items stay highlighted as new while the center that marked them seen stays open. */
export function unreadNotificationIds(
	pages: readonly AccountNotificationPage[] | undefined,
): string[] {
	return (pages?.flatMap((page) => page.items) ?? [])
		.filter((item) => item.read_at == null)
		.map((item) => item.id);
}

/** Optimistic `read-all`: every unread item becomes read and the unread count drops to zero. */
export function markNotificationPagesSeen<Page extends AccountNotificationPage>(
	pages: readonly Page[],
	readAt: string,
): Page[] {
	return pages.map((page) => ({
		...page,
		items: page.items.map((item) => (item.read_at != null ? item : { ...item, read_at: readAt })),
		unread_count: 0,
	}));
}

/** Optimistic delete: removing an unread item lowers the unread count. */
export function removeNotificationFromPages<Page extends AccountNotificationPage>(
	pages: readonly Page[],
	id: string,
): Page[] {
	let wasUnread = false;
	const filtered = pages.map((page) => {
		const item = page.items.find((notification) => notification.id === id);
		if (item !== undefined && item.read_at == null) wasUnread = true;
		return { ...page, items: page.items.filter((notification) => notification.id !== id) };
	});
	return wasUnread
		? filtered.map((page) => ({ ...page, unread_count: Math.max(0, page.unread_count - 1) }))
		: filtered;
}

export function getPendingNotificationCount(
	invitations: readonly unknown[] | null | undefined,
	accountUnreadCount = 0,
): number {
	return (invitations?.length ?? 0) + accountUnreadCount;
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

/** Badge text for the trigger; null hides the badge. */
export function notificationBadgeLabel(count: number): string | null {
	if (count <= 0) return null;
	return count > 9 ? "9+" : String(count);
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

function formatRelative(value: number, unit: "minute" | "hour" | "day"): string {
	if (typeof Intl.RelativeTimeFormat === "function") {
		return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);
	}
	// Hermes (React Native) has no RelativeTimeFormat; match its English `numeric: "auto"` output.
	if (unit === "day" && Math.abs(value) === 1) return value < 0 ? "yesterday" : "tomorrow";
	const count = Math.abs(value);
	const label = `${count} ${unit}${count === 1 ? "" : "s"}`;
	return value < 0 ? `${label} ago` : `in ${label}`;
}

export function formatNotificationTime(value: Date, now = Date.now()): string {
	const seconds = Math.round((value.getTime() - now) / 1_000);
	const absoluteSeconds = Math.abs(seconds);
	if (absoluteSeconds < 45) return "Now";

	if (absoluteSeconds < 60 * 60) return formatRelative(Math.round(seconds / 60), "minute");
	if (absoluteSeconds < 60 * 60 * 24) return formatRelative(Math.round(seconds / 3_600), "hour");
	if (absoluteSeconds < 60 * 60 * 24 * 7)
		return formatRelative(Math.round(seconds / 86_400), "day");

	return value.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(value.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
	});
}
