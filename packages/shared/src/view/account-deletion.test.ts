import { describe, expect, mock, test } from "bun:test";
import { ApiClientError } from "../api/read-transport";
import { deleteAccountThenSignOut, shouldShowAccountDeletionPage } from "./account-deletion";

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

describe("deleteAccountThenSignOut", () => {
	test("signs out after the hosted service accepts the deletion", async () => {
		const calls: string[] = [];
		const result = await deleteAccountThenSignOut({
			deleteAccount: async () => {
				calls.push("delete");
				return null;
			},
			signOut: async () => {
				calls.push("signOut");
			},
		});
		expect(result).toEqual({ outcome: "signed-out" });
		expect(calls).toEqual(["delete", "signOut"]);
	});

	test("keeps the session and never retries when the outcome is unknown", async () => {
		const deleteAccount = mock(async () => {
			throw new ApiClientError(500);
		});
		const signOut = mock(async () => undefined);
		expect(await deleteAccountThenSignOut({ deleteAccount, signOut })).toEqual({
			outcome: "uncertain",
		});
		expect(deleteAccount).toHaveBeenCalledTimes(1);
		expect(signOut).not.toHaveBeenCalled();
	});

	test("does not treat a later 401 as proof of deletion", async () => {
		const result = await deleteAccountThenSignOut({
			deleteAccount: async () => {
				throw new ApiClientError(401);
			},
			signOut: async () => undefined,
		});
		expect(result).toEqual({ outcome: "uncertain" });
	});

	test("reports an accepted deletion when local sign-out fails", async () => {
		const result = await deleteAccountThenSignOut({
			deleteAccount: async () => null,
			signOut: async () => {
				throw new Error("offline");
			},
		});
		expect(result).toEqual({ outcome: "accepted", signOutFailed: true });
	});
});
