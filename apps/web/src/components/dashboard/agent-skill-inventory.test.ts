import { describe, expect, test } from "bun:test";
import type { components } from "@/lib/api-schemas";
import { fetchAgentProjectSkills } from "./agent-skill-inventory";

type Skill = components["schemas"]["SkillSummaryResponse"];

function skill(id: string, skillKey: string, projectId: string): Skill {
	return {
		id,
		skill_key: skillKey,
		name: skillKey,
		description: null,
		version: 1,
		source: "cloud",
		authority: "cloud",
		source_repo: null,
		agent_types: null,
		file_count: 1,
		content_hash: "a".repeat(64),
		is_active: true,
		created_at: "2026-08-01T00:00:00Z",
		updated_at: "2026-08-01T00:00:00Z",
		project_id: projectId,
		project_name: projectId,
		project_kind: projectId === "project_primary" ? "environment" : "workspace",
	};
}

describe("Agent effective Project Skill inventory", () => {
	test("finds a context-only Skill and keeps effective Project ordering", async () => {
		const calls: string[] = [];
		const result = await fetchAgentProjectSkills(
			["project_primary", "project_context_1", "project_context_2"],
			async (projectId, page, pageSize) => {
				calls.push(`${projectId}:${page}:${pageSize}`);
				const items =
					projectId === "project_context_1"
						? [skill("context-1", "context-only", projectId)]
						: projectId === "project_context_2"
							? [skill("context-2", "later-context", projectId)]
							: [];
				return { items, total: items.length, page, page_size: pageSize };
			},
		);

		expect(calls).toEqual([
			"project_primary:1:200",
			"project_context_1:1:200",
			"project_context_2:1:200",
		]);
		expect(result.map((item) => item.skill_key)).toEqual(["context-only", "later-context"]);
	});

	test("preserves the same Skill key in two Projects by project identity", async () => {
		const result = await fetchAgentProjectSkills(
			["project_primary", "project_context"],
			async (projectId, page, pageSize) => ({
				items: [skill(`skill-${projectId}`, "shared-key", projectId)],
				total: 1,
				page,
				page_size: pageSize,
			}),
		);

		expect(result.map((item) => `${item.project_id}:${item.skill_key}`)).toEqual([
			"project_primary:shared-key",
			"project_context:shared-key",
		]);
	});

	test("walks every server-filtered page", async () => {
		const calls: number[] = [];
		const result = await fetchAgentProjectSkills(
			["project_primary"],
			async (projectId, page, pageSize) => {
				calls.push(page);
				return {
					items:
						page === 1
							? [skill("one", "one", projectId), skill("two", "two", projectId)]
							: [skill("three", "three", projectId)],
					total: 3,
					page,
					page_size: pageSize,
				};
			},
			{ pageSize: 2 },
		);

		expect(calls).toEqual([1, 2]);
		expect(result.map((item) => item.skill_key)).toEqual(["one", "two", "three"]);
	});

	test("fails closed on leaked rows, invalid pagination, or a truncated inventory", async () => {
		await expect(
			fetchAgentProjectSkills(["project_primary"], async (_projectId, page, pageSize) => ({
				items: [skill("leaked", "leaked", "project_other")],
				total: 1,
				page,
				page_size: pageSize,
			})),
		).rejects.toThrow("did not match the requested Project");

		await expect(
			fetchAgentProjectSkills(["project_primary"], async (projectId, page, pageSize) => ({
				items: [skill("one", "one", projectId)],
				page,
				page_size: pageSize,
			})),
		).rejects.toThrow("valid pagination metadata");

		await expect(
			fetchAgentProjectSkills(["project_primary"], async (projectId, page, pageSize) => ({
				items: page === 1 ? [skill("one", "one", projectId)] : [],
				total: 2,
				page,
				page_size: pageSize,
			})),
		).rejects.toThrow("ended before every Project row was loaded");

		await expect(
			fetchAgentProjectSkills(
				["project_primary"],
				async (projectId, page, pageSize) => ({
					items: [skill(`page-${page}`, `page-${page}`, projectId)],
					total: 2,
					page,
					page_size: pageSize,
				}),
				{ pageSize: 1, maxPages: 1 },
			),
		).rejects.toThrow("Too many agent Skill pages");
	});
});
