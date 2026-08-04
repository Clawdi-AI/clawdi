import { describe, expect, test } from "bun:test";
import {
	fetchAgentScopedSkillDetail,
	resolveAgentSkillProjectAccess,
} from "./agent-skill-detail-scope";

class NotFoundError extends Error {}

describe("Agent Skill detail Project scope", () => {
	test("accepts only bound explicit Projects and never turns a tampered Project into a candidate", () => {
		expect(resolveAgentSkillProjectAccess(["primary", "context"], "context")).toEqual({
			kind: "bound",
			projectIds: ["context"],
		});
		expect(resolveAgentSkillProjectAccess(["primary", "context"], "other")).toEqual({
			kind: "unbound",
			projectId: "other",
		});
	});

	test("rejects an omitted Project instead of searching effective read order", () => {
		const access = resolveAgentSkillProjectAccess(["primary", "context", "context"], "");
		expect(access).toEqual({ kind: "missing" });
	});

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
		).rejects.toThrow("did not match the requested Agent Project");
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
