import { describe, expect, test } from "bun:test";
import {
	formatApiError,
	groupVaultConflicts,
	isVaultConflictDetail,
	parseApiDetail,
} from "./vault-conflicts";

describe("vault conflict API details", () => {
	test("recognizes nested FastAPI vault conflict details", () => {
		const detail = parseApiDetail(
			JSON.stringify({
				detail: {
					code: "vault_conflicts_blocked",
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

	test("keeps recognizing older conflict details that used error", () => {
		const detail = parseApiDetail(
			JSON.stringify({
				detail: {
					error: "vault_conflicts_blocked",
					message: "Source project has 1 vault key that already exists.",
				},
			}),
		);

		expect(isVaultConflictDetail(detail)).toBe(true);
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

	test("groups conflict rows by source vault for the UI", () => {
		const conflicts = [
			{ vault_slug: "prod", section: "api", item_name: "TOKEN" },
			{ vault_slug: "prod", section: "", item_name: "DATABASE_URL" },
			{ vault_slug: "github-secrets", section: "deploy", item_name: "PAT" },
		];

		expect(groupVaultConflicts(conflicts)).toEqual([
			{
				vaultSlug: "prod",
				items: [
					{ vault_slug: "prod", section: "api", item_name: "TOKEN" },
					{ vault_slug: "prod", section: "", item_name: "DATABASE_URL" },
				],
			},
			{
				vaultSlug: "github-secrets",
				items: [{ vault_slug: "github-secrets", section: "deploy", item_name: "PAT" }],
			},
		]);
	});
});
