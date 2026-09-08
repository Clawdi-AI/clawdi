import { describe, expect, test } from "bun:test";
import { fetchAgentScopedSkillDetail } from "./agent-skill-detail-scope";

class NotFoundError extends Error {}

describe("Agent Skill detail Project scope", () => {
	test("fails closed on non-404 errors and mismatched Project responses", async () => {
		const calls: string[] = [];
		await expect(
			fetchAgentScopedSkillDetail(
				["primary", "context"],
				async (projectId) => {
					calls.push(projectId);
					throw new Error("unavailable");
				},
				(error) => error instanceof NotFoundError,
			),
		).rejects.toThrow("unavailable");
		expect(calls).toEqual(["primary"]);

		await expect(
			fetchAgentScopedSkillDetail(
				["primary"],
				async () => ({ project_id: "other" }),
				(error) => error instanceof NotFoundError,
			),
		).rejects.toThrow("did not match the requested Workspace or Project");
	});

	test("returns the final not-found result after all bound Projects miss", async () => {
		await expect(
			fetchAgentScopedSkillDetail(
				["primary", "context"],
				async (projectId) => {
					throw new NotFoundError(projectId);
				},
				(error) => error instanceof NotFoundError,
			),
		).rejects.toThrow("context");
	});
});
