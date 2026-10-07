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

/**
 * Models clerk-js behind the React SDK for a deleted user: `signOut` enters the
 * transitive `undefined` session state, then rejects when the Frontend API refuses the
 * removal. `setActive({ session: null })` resolves after Clerk emits the change.
 */
function deletedUserClerk(active: string | null, { emitAfterMs = 5 } = {}) {
	const state: { session: string | null | undefined } = { session: active };
	const listeners = new Set<(resources: { session?: { id: string } | null }) => void>();
	const current = (): { id: string } | null | undefined =>
		typeof state.session === "string" ? { id: state.session } : state.session;
	const emit = () => {
		for (const listener of listeners) listener({ session: current() });
	};
	const clerk = {
		get session() {
			return current();
		},
		signOut: mock(
			async (_options?: { sessionId?: string; redirectUrl?: string }): Promise<unknown> => {
				state.session = undefined;
				emit();
				throw new Error("resource_not_found");
			},
		),
		setActive: mock(
			(_params: { session: null }): Promise<unknown> =>
				new Promise((resolve) =>
					setTimeout(() => {
						state.session = null;
						emit();
						resolve(undefined);
					}, emitAfterMs),
				),
		),
		addListener: mock((listener: (resources: { session?: { id: string } | null }) => void) => {
			listeners.add(listener);
			listener({ session: current() });
			return () => {
				listeners.delete(listener);
			};
		}),
		listenerCount: () => listeners.size,
	} satisfies DeletedAccountClerk & { listenerCount: () => number };
	return clerk;
}

describe("endDeletedAccountSession", () => {
	test("uses Clerk's sign-out when it succeeds", async () => {
		const clerk = deletedUserClerk("sess_a");
		clerk.signOut.mockImplementation(async () => undefined);
		expect(await endDeletedAccountSession(clerk, { redirectUrl: "/sign-in" })).toBe("signed-out");
		expect(clerk.signOut).toHaveBeenCalledWith({ sessionId: undefined, redirectUrl: "/sign-in" });
		expect(clerk.setActive).not.toHaveBeenCalled();
	});

	test("single session: clears the transitive session after sign-out is rejected", async () => {
		const clerk = deletedUserClerk("sess_a", { emitAfterMs: 20 });
		expect(await endDeletedAccountSession(clerk)).toBe("signed-out");
		expect(clerk.setActive).toHaveBeenCalledWith({ session: null });
		expect(clerk.session).toBeNull();
		expect(clerk.listenerCount()).toBe(0);
	});

	test("multi-session: targets the deleted session and clears it", async () => {
		const clerk = deletedUserClerk("sess_a");
		expect(await endDeletedAccountSession(clerk, { sessionId: "sess_a" })).toBe("signed-out");
		expect(clerk.signOut).toHaveBeenCalledWith({ sessionId: "sess_a", redirectUrl: undefined });
		expect(clerk.session).toBeNull();
		expect(clerk.listenerCount()).toBe(0);
	});

	test("does not mistake the transitive undefined session for a cleared one", async () => {
		const clerk = deletedUserClerk("sess_a");
		clerk.setActive.mockImplementation(() => new Promise(() => {}));
		expect(await endDeletedAccountSession(clerk, { timeoutMs: 30 })).toBe("failed");
		expect(clerk.session).toBeUndefined();
		expect(clerk.listenerCount()).toBe(0);
	});

	test("fails fast when setActive rejects", async () => {
		const clerk = deletedUserClerk("sess_a");
		clerk.setActive.mockImplementation(() => Promise.reject(new Error("not loaded")));
		const started = Date.now();
		expect(await endDeletedAccountSession(clerk, { timeoutMs: 5_000 })).toBe("failed");
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(clerk.listenerCount()).toBe(0);
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
				return "signed-out";
			},
		});
		expect(result).toEqual({ outcome: "deleted", session: "signed-out" });
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
