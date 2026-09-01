import { describe, expect, test } from "bun:test";
import {
	type AccountNotification,
	filterAccountNotifications,
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterDescription,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	getProjectInvitationAccessCopy,
	NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS,
	type ProjectInvitationNotification,
	resolveNotificationUrl,
} from "./notification-center.logic";

const walletNotification = {
	id: "wallet-low-balance",
	title: "Your wallet balance is down to $1.25",
	description: "Top up before paid requests begin to fail.",
	category: "Wallet",
	createdAt: new Date("2026-05-15T08:00:00Z"),
	read: false,
	actionLabel: "Top up",
	actionUrl: "https://cloud.clawdi.ai/?settings=billing-wallet#billing",
	severity: "warning",
} satisfies AccountNotification;

const invitation = {
	id: "inv_1",
	project_id: "proj_1",
	project_name: "Shared Workspace",
	project_kind: "workspace",
	owner_display: "Ada Lovelace",
	owner_handle: "ada",
	invitee_email: "viewer@example.com",
	invited_by_user_id: "user_1",
	invited_by_display: "Ada Lovelace",
	created_at: "2026-05-15T08:00:00Z",
} satisfies ProjectInvitationNotification;

describe("notification center logic", () => {
	test("counts pending notifications and names the compact trigger", () => {
		expect(getPendingNotificationCount(undefined)).toBe(0);
		expect(getPendingNotificationCount([])).toBe(0);
		expect(getPendingNotificationCount([invitation])).toBe(1);
		expect(getPendingNotificationCount([invitation], 1)).toBe(2);
		expect(getPendingNotificationCount([invitation, { ...invitation, id: "inv_2" }])).toBe(2);

		expect(getNotificationCenterTriggerLabel(0)).toBe("Notifications");
		expect(getNotificationCenterTriggerLabel(1)).toBe("Notifications, 1 new item");
		expect(getNotificationCenterTriggerLabel(2)).toBe("Notifications, 2 new items");
	});

	test("filters history into all and unread views", () => {
		const readNotification = { ...walletNotification, id: "read", read: true };
		expect(filterAccountNotifications([walletNotification, readNotification], "all")).toHaveLength(
			2,
		);
		expect(filterAccountNotifications([walletNotification, readNotification], "unread")).toEqual([
			walletNotification,
		]);

		const allEmpty = getNotificationCenterEmptyCopy("all");
		expect(allEmpty.title).toBe("No notifications yet");
		expect(allEmpty.description).toContain("project invitations");
		const unreadEmpty = getNotificationCenterEmptyCopy("unread");
		expect(unreadEmpty.title).toBe("You're all caught up");
		expect(unreadEmpty.description).toContain("account updates");
		expect(getNotificationCenterDescription()).toContain("Account activity");
		expect(getNotificationCenterDescription()).toContain("project invitations");
	});

	test("accepts same-origin and HTTPS notification actions only", () => {
		const relative = resolveNotificationUrl("/deploy", "https://cloud.clawdi.ai");
		expect(relative?.kind).toBe("same-origin");
		expect(relative?.url.href).toBe("https://cloud.clawdi.ai/deploy");
		expect(
			resolveNotificationUrl("https://www.clawdi.ai/dashboard", "https://cloud.clawdi.ai")?.kind,
		).toBe("external");
		expect(resolveNotificationUrl("https://example.com", "https://cloud.clawdi.ai")).toBeNull();
		expect(resolveNotificationUrl("http://example.com", "https://cloud.clawdi.ai")).toBeNull();
		expect(resolveNotificationUrl("javascript:alert(1)", "https://cloud.clawdi.ai")).toBeNull();
	});

	test("keeps project invitation invariants as the first notification type", () => {
		expect(getProjectInvitationAccessCopy()).toContain("read-only access");
		expect(getProjectInvitationAccessCopy()).toContain("Adding the Project to an agent");
		expect(getProjectInvitationAccessCopy()).toContain("separate step");

		const accepted = getAcceptedProjectInvitationToastCopy("Shared Workspace");
		expect(accepted.title).toBe("Joined Shared Workspace");
		expect(getAcceptedProjectInvitationToastCopy().title).toBe("Project Joined");
		expect(accepted.description).toContain("Read-only access");
		expect(accepted.description).toContain("Open the Project");
		expect(accepted.description).toContain("link it to an Agent");
	});

	test("refreshes canonical OpenAPI membership caches after accepting an invitation", () => {
		expect(NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS).toContainEqual(["get", "/v1/projects"]);
		expect(NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS).toContainEqual(["get", "/v1/agents"]);
		expect(NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS).not.toContainEqual(["projects"]);
		expect(NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS).not.toContainEqual(["agents"]);
	});
});
