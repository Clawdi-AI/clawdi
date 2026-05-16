import { describe, expect, test } from "bun:test";
import { formatApiError, isVaultConflictDetail, parseApiDetail } from "./vault-conflicts";

describe("vault conflict API details", () => {
	test("recognizes nested FastAPI vault conflict details", () => {
		const detail = parseApiDetail(
			JSON.stringify({
				detail: {
					error: "vault_conflicts_blocked",
					message: "Source project has 1 vault key that already exists.",
					conflicts: [{ vault_slug: "prod", section: "api", item_name: "TOKEN" }],
				},
			}),
		);

		expect(isVaultConflictDetail(detail)).toBe(true);
		if (isVaultConflictDetail(detail)) {
			expect(detail.conflicts?.[0]).toEqual({
				vault_slug: "prod",
				section: "api",
				item_name: "TOKEN",
			});
		}
	});

	test("formats structured API errors without exposing raw JSON", () => {
		const message = formatApiError(
			JSON.stringify({
				detail: {
					error: "already_member",
					message: "Already a member.",
				},
			}),
		);

		expect(message).toBe("Already a member.");
	});

	test("keeps plain text API errors readable", () => {
		expect(formatApiError("project not found")).toBe("project not found");
		expect(isVaultConflictDetail("project not found")).toBe(false);
	});
});
