import { describe, expect, test } from "bun:test";
import {
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS,
	type ProjectInvitationNotification,
	resolveNotificationUrl,
} from "./notification-center.logic";

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

	test("uses the notification history empty copy", () => {
		expect(getNotificationCenterEmptyCopy().title).toBe("No notifications yet");
	});

	test("accepts same-origin and HTTPS notification actions only", () => {
		const relative = resolveNotificationUrl("/deploy", "https://cloud.clawdi.ai");
		expect(relative?.kind).toBe("same-origin");
		expect(relative?.url.href).toBe("https://cloud.clawdi.ai/deploy");
		expect(
			resolveNotificationUrl("https://www.clawdi.ai/dashboard", "https://cloud.clawdi.ai")?.kind,
		).toBe("external");
		const apex = resolveNotificationUrl(
			"https://clawdi.ai/dashboard?settings=billing",
			"https://cloud.clawdi.ai",
		);
		expect(apex?.kind).toBe("external");
		expect(apex?.url.href).toBe("https://clawdi.ai/dashboard?settings=billing");
		for (const url of [
			"https://clawdi.ai.evil.test/dashboard",
			"https://clawdi.ai@evil.test/dashboard",
			"https://evil.clawdi.ai/dashboard",
			"http://clawdi.ai/dashboard",
			"https://clawdi.ai:444/dashboard",
		]) {
			expect(resolveNotificationUrl(url, "https://cloud.clawdi.ai")).toBeNull();
		}
		expect(resolveNotificationUrl("https://example.com", "https://cloud.clawdi.ai")).toBeNull();
		expect(resolveNotificationUrl("http://example.com", "https://cloud.clawdi.ai")).toBeNull();
		expect(resolveNotificationUrl("javascript:alert(1)", "https://cloud.clawdi.ai")).toBeNull();
	});

	test("preserves the path, search, and hash of same-origin notification actions", () => {
		const origin = "https://cloud.clawdi.ai";
		const path = "/agents/11111111-1111-4111-8111-111111111111";
		const href = `${path}?settings=billing-wallet#billing`;
		for (const value of [href, `${origin}${href}`]) {
			const target = resolveNotificationUrl(value, origin);
			expect(target?.kind).toBe("same-origin");
			expect(target?.url.pathname).toBe(path);
			expect(target?.url.search).toBe("?settings=billing-wallet");
			expect(target?.url.hash).toBe("#billing");
		}
	});

	test("includes the accepted Project name with a fallback", () => {
		const accepted = getAcceptedProjectInvitationToastCopy("Shared Workspace");
		expect(accepted.title).toBe("Joined Shared Workspace");
		expect(getAcceptedProjectInvitationToastCopy().title).toBe("Project joined");
	});

	test("declares canonical OpenAPI membership cache keys", () => {
		expect(NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS).toContainEqual(["get", "/v1/projects"]);
		expect(NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS).toContainEqual(["get", "/v1/agents"]);
		expect(NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS).not.toContainEqual(["projects"]);
		expect(NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS).not.toContainEqual(["agents"]);
	});
});
