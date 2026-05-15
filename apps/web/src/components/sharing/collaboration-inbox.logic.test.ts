import { describe, expect, test } from "bun:test";
import {
	type CollaborationInvitation,
	getAcceptedInvitationToastCopy,
	getCollaborationInboxEmptyCopy,
	getCollaborationInboxTitle,
	getCollaborationInboxTriggerLabel,
	getInvitationAccessCopy,
	getPendingInvitationCount,
} from "./collaboration-inbox.logic";

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
} satisfies CollaborationInvitation;

describe("collaboration inbox logic", () => {
	test("counts pending invitations and names the compact trigger", () => {
		expect(getPendingInvitationCount(undefined)).toBe(0);
		expect(getPendingInvitationCount([])).toBe(0);
		expect(getPendingInvitationCount([invitation])).toBe(1);
		expect(getPendingInvitationCount([invitation, { ...invitation, id: "inv_2" }])).toBe(2);

		expect(getCollaborationInboxTriggerLabel(0)).toBe("Collaboration inbox");
		expect(getCollaborationInboxTriggerLabel(1)).toBe("Collaboration inbox, 1 pending invitation");
		expect(getCollaborationInboxTriggerLabel(2)).toBe("Collaboration inbox, 2 pending invitations");
	});

	test("formats title and empty copy without Skills-specific language", () => {
		expect(getCollaborationInboxTitle(0)).toBe("Collaboration inbox");
		expect(getCollaborationInboxTitle(1)).toBe("1 pending invitation");
		expect(getCollaborationInboxTitle(3)).toBe("3 pending invitations");

		const empty = getCollaborationInboxEmptyCopy();
		expect(empty.title).toBe("No pending invitations");
		expect(empty.description).toContain("Project invitations");
		expect(empty.description).not.toContain("Skills");
	});

	test("encodes access invariants and next-action copy", () => {
		expect(getInvitationAccessCopy()).toContain("read-only viewer Project access");
		expect(getInvitationAccessCopy()).toContain("Use with agent");
		expect(getInvitationAccessCopy()).toContain("separate explicit step");

		const accepted = getAcceptedInvitationToastCopy("Shared Workspace");
		expect(accepted.title).toBe("Joined Shared Workspace");
		expect(accepted.description).toContain("read-only viewer Project access");
		expect(accepted.description).toContain("Open project");
		expect(accepted.description).toContain("Use with agent");
	});
});
