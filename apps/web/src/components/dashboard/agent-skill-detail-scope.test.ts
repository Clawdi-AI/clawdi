import { describe, expect, test } from "bun:test";
import {
	fetchAgentScopedSkillDetail,
	resolveAgentSkillProjectAccess,
} from "./agent-skill-detail-scope";

class NotFoundError extends Error {}

describe("Agent Skill detail Project scope", () => {
	const bindings = [
		{ project_id: "primary", binding_type: "primary" },
		{ project_id: "context", binding_type: "context" },
	];

	test("accepts only bound explicit Projects and never turns a tampered Project into a candidate", () => {
		expect(resolveAgentSkillProjectAccess(bindings, "context")).toEqual({
			kind: "bound",
			projectIds: ["context"],
		});
		expect(resolveAgentSkillProjectAccess(bindings, "other")).toEqual({
			kind: "unbound",
			projectId: "other",
		});
	});

	test("resolves omitted legacy context only to one primary Workspace", () => {
		expect(resolveAgentSkillProjectAccess(bindings, "")).toEqual({
			kind: "bound",
			projectIds: ["primary"],
		});
		expect(
			resolveAgentSkillProjectAccess([{ project_id: "context", binding_type: "context" }], ""),
		).toEqual({ kind: "unavailable" });
		expect(
			resolveAgentSkillProjectAccess(
				[...bindings, { project_id: "other-primary", binding_type: "primary" }],
				"",
			),
		).toEqual({ kind: "unavailable" });
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
