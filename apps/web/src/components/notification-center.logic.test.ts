import { describe, expect, test } from "bun:test";
import {
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTitle,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	getProjectInvitationAccessCopy,
	type ProjectInvitationNotification,
} from "./notification-center.logic";

const invitation = {
	id: "inv_1",
	project_id: "proj_1",
	project_name: "Shared Workspace",
	project_kind: "agent",
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
		expect(getPendingNotificationCount([invitation, { ...invitation, id: "inv_2" }])).toBe(2);

		expect(getNotificationCenterTriggerLabel(0)).toBe("Notification center");
		expect(getNotificationCenterTriggerLabel(1)).toBe("Notification center, 1 pending invitation");
		expect(getNotificationCenterTriggerLabel(2)).toBe("Notification center, 2 pending invitations");
	});

	test("formats notification title and empty copy without Skills-specific language", () => {
		expect(getNotificationCenterTitle(0)).toBe("Notification center");
		expect(getNotificationCenterTitle(1)).toBe("1 pending notification");
		expect(getNotificationCenterTitle(3)).toBe("3 pending notifications");

		const empty = getNotificationCenterEmptyCopy();
		expect(empty.title).toBe("No pending notifications");
		expect(empty.description).toContain("Project invitations");
		expect(empty.description).toContain("action-required updates");
		expect(empty.description).not.toContain("Skills");
	});

	test("keeps project invitation invariants as the first notification type", () => {
		expect(getProjectInvitationAccessCopy()).toContain("read-only viewer Project access");
		expect(getProjectInvitationAccessCopy()).toContain("Use with agent");
		expect(getProjectInvitationAccessCopy()).toContain("separate explicit step");

		const accepted = getAcceptedProjectInvitationToastCopy("Shared Workspace");
		expect(accepted.title).toBe("Joined Shared Workspace");
		expect(accepted.description).toContain("read-only viewer Project access");
		expect(accepted.description).toContain("Open project");
		expect(accepted.description).toContain("Use with agent");
	});
});
