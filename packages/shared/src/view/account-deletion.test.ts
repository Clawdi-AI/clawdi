import { describe, expect, mock, test } from "bun:test";
import { ApiClientError } from "../api/read-transport";
import {
	type DeletedAccountClerk,
	deleteAccountThenSignOut,
	endDeletedAccountSession,
	shouldShowAccountDeletionPage,
} from "./account-deletion";

describe("shouldShowAccountDeletionPage", () => {
	test("replaces Clerk's built-in delete only when self-deletion is disabled", () => {
		expect(shouldShowAccountDeletionPage({ deleteSelfEnabled: false })).toBe(true);
		expect(shouldShowAccountDeletionPage({ deleteSelfEnabled: true })).toBe(false);
	});

	test("stays hidden while the user is unknown", () => {
		expect(shouldShowAccountDeletionPage(null)).toBe(false);
		expect(shouldShowAccountDeletionPage(undefined)).toBe(false);
		expect(shouldShowAccountDeletionPage({})).toBe(false);
	});
});

/** Models clerk-js: signOut rejects for a deleted user; handleUnauthenticated refetches the Client. */
function deletedUserClerk(sessions: string[], active: string) {
	const state = { sessions, active: active as string | null };
	const clerk = {
		get session() {
			return state.active ? { id: state.active } : null;
		},
		signOut: mock(async (): Promise<unknown> => {
			throw new Error("resource_not_found");
		}),
		handleUnauthenticated: mock(async () => {
			state.sessions = state.sessions.filter((id) => id !== active);
			state.active = state.sessions[0] ?? null;
		}),
	} satisfies DeletedAccountClerk;
	return clerk;
}

describe("endDeletedAccountSession", () => {
	test("uses Clerk's sign-out when it succeeds", async () => {
		const clerk = deletedUserClerk(["sess_a"], "sess_a");
		clerk.signOut.mockImplementation(async () => undefined);
		expect(await endDeletedAccountSession(clerk, { redirectUrl: "/sign-in" })).toBe("signed-out");
		expect(clerk.signOut).toHaveBeenCalledWith({ sessionId: undefined, redirectUrl: "/sign-in" });
		expect(clerk.handleUnauthenticated).not.toHaveBeenCalled();
	});

	test("single session: clears local state when sign-out is rejected", async () => {
		const clerk = deletedUserClerk(["sess_a"], "sess_a");
		expect(await endDeletedAccountSession(clerk)).toBe("cleared");
		expect(clerk.handleUnauthenticated).toHaveBeenCalledTimes(1);
		expect(clerk.session).toBeNull();
	});

	test("multi-session: clears only the deleted session when sign-out is rejected", async () => {
		const clerk = deletedUserClerk(["sess_a", "sess_b"], "sess_a");
		expect(await endDeletedAccountSession(clerk, { sessionId: "sess_a" })).toBe("cleared");
		expect(clerk.signOut).toHaveBeenCalledWith({ sessionId: "sess_a", redirectUrl: undefined });
		expect(clerk.session?.id).toBe("sess_b");
	});

	test("reports failure when Clerk cannot be reached", async () => {
		const clerk = deletedUserClerk(["sess_a"], "sess_a");
		clerk.handleUnauthenticated.mockImplementation(async () => {
			throw new Error("network_error");
		});
		expect(await endDeletedAccountSession(clerk, { sessionId: "sess_a" })).toBe("failed");
	});

	test("reports failure when the deleted session is still active", async () => {
		const clerk = deletedUserClerk(["sess_a"], "sess_a");
		clerk.handleUnauthenticated.mockImplementation(async () => undefined);
		expect(await endDeletedAccountSession(clerk)).toBe("failed");
	});
});

describe("deleteAccountThenSignOut", () => {
	test("ends the session after the hosted service accepts the deletion", async () => {
		const calls: string[] = [];
		const result = await deleteAccountThenSignOut({
			deleteAccount: async () => {
				calls.push("delete");
				return null;
			},
			endSession: async () => {
				calls.push("endSession");
				return "cleared";
			},
		});
		expect(result).toEqual({ outcome: "deleted", session: "cleared" });
		expect(calls).toEqual(["delete", "endSession"]);
	});

	test("keeps the session and never retries when the outcome is unknown", async () => {
		const deleteAccount = mock(async () => {
			throw new ApiClientError(500);
		});
		const endSession = mock(async () => "signed-out" as const);
		expect(await deleteAccountThenSignOut({ deleteAccount, endSession })).toEqual({
			outcome: "uncertain",
		});
		expect(deleteAccount).toHaveBeenCalledTimes(1);
		expect(endSession).not.toHaveBeenCalled();
	});

	test("does not treat a later 401 as proof of deletion", async () => {
		const result = await deleteAccountThenSignOut({
			deleteAccount: async () => {
				throw new ApiClientError(401);
			},
			endSession: async () => "signed-out",
		});
		expect(result).toEqual({ outcome: "uncertain" });
	});
});
