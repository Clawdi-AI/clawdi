import { describe, expect, test } from "bun:test";
import {
	type ActionRequiredNotification,
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterDescription,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTitle,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	getProjectInvitationAccessCopy,
	NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS,
	type ProjectInvitationNotification,
} from "./notification-center.logic";

const walletAction = {
	id: "wallet-low-balance",
	title: "Your Wallet balance is running low",
	description: "Top up before Wallet-backed services are interrupted.",
	badge: "Wallet",
	actionLabel: "Top up",
	severity: "warning",
} satisfies ActionRequiredNotification;

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
		expect(getPendingNotificationCount([invitation], [walletAction])).toBe(2);
		expect(getPendingNotificationCount([invitation, { ...invitation, id: "inv_2" }])).toBe(2);

		expect(getNotificationCenterTriggerLabel(0)).toBe("Notification Center");
		expect(getNotificationCenterTriggerLabel(1)).toBe(
			"Notification Center, 1 Pending Notification",
		);
		expect(getNotificationCenterTriggerLabel(2)).toBe(
			"Notification Center, 2 Pending Notifications",
		);
	});

	test("formats notification title and empty copy without Skills-specific language", () => {
		expect(getNotificationCenterTitle(0)).toBe("Notification Center");
		expect(getNotificationCenterTitle(1)).toBe("1 Pending Notification");
		expect(getNotificationCenterTitle(3)).toBe("3 Pending Notifications");

		const empty = getNotificationCenterEmptyCopy();
		expect(empty.title).toBe("No Pending Notifications");
		expect(empty.description).toContain("Project invitations");
		expect(empty.description).toContain("action-required updates");
		expect(empty.description).not.toContain("Skills");
		expect(getNotificationCenterDescription()).toContain("account actions");
		expect(getNotificationCenterDescription()).toContain("project invitations");
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
