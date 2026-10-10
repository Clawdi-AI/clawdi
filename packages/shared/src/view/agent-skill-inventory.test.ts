import { describe, expect, test } from "bun:test";
import type { components } from "../api";
import {
	agentSkillGuardPresentation,
	agentSkillInstallCopy,
	agentSkillsHaveRetryableInstallFailure,
	fetchAgentProjectSkills,
} from "./agent-skill-inventory";

type Skill = components["schemas"]["SkillSummaryResponse"];

test.each(["library", "project", "bundled"] as const)(
	"blocked %s skills suggest reviewing the GitHub source",
	(source) => {
		const presentation = agentSkillGuardPresentation({
			source,
			convergence: "failed",
			observation_error_code: "guard_blocked",
		});
		if (!presentation) throw new Error("Missing guard presentation");
		expect(agentSkillInstallCopy[presentation.message]).toBe(
			"Hermes's Skills Guard blocked this skill (it flagged risky code). Install it from its GitHub source to review it, or choose another skill.",
		);
	},
);

test("already GitHub-sourced skills suggest choosing another skill instead of reinstalling", () => {
	const presentation = agentSkillGuardPresentation({
		source: "github",
		convergence: "failed",
		observation_error_code: "guard_blocked",
	});
	if (!presentation) throw new Error("Missing guard presentation");
	expect(agentSkillInstallCopy[presentation.message]).toBe(
		"Hermes's Skills Guard flagged this skill's code as risky and blocked installation. Choose another skill.",
	);
});

test.each(["library", "project", "github"] as const)(
	"confirmation-required %s skills explain that retries will not help",
	(source) => {
		const presentation = agentSkillGuardPresentation({
			source,
			convergence: "failed",
			observation_error_code: "guard_confirmation_required",
		});
		if (!presentation) throw new Error("Missing guard presentation");
		expect(agentSkillInstallCopy[presentation.message]).toBe(
			"Hermes's Skills Guard needs explicit confirmation for this skill. Retrying won't help.",
		);
	},
);

test("other failures and unobserved or installed skills keep their existing presentation", () => {
	for (const observation_error_code of ["reconcile_failed", null] as const) {
		expect(
			agentSkillGuardPresentation({
				source: "project",
				convergence: "failed",
				observation_error_code,
			}),
		).toBeNull();
	}
	for (const convergence of ["installed", "not_observed"] as const) {
		for (const observation_error_code of [
			"guard_blocked",
			"guard_confirmation_required",
		] as const) {
			expect(
				agentSkillGuardPresentation({ source: "github", convergence, observation_error_code }),
			).toBeNull();
		}
	}
	expect(agentSkillGuardPresentation(null)).toBeNull();
	expect(agentSkillGuardPresentation(undefined)).toBeNull();
});

test.each(["guard_blocked", "guard_confirmation_required"] as const)(
	"%s suppresses the retry banner for both Cloud and duplicate workspace failure status",
	(observation_error_code) => {
		const guard = {
			skill_key: "review",
			source: "github" as const,
			convergence: "failed" as const,
			observation_error_code,
		};
		expect(agentSkillsHaveRetryableInstallFailure([guard])).toBe(false);
		expect(
			agentSkillsHaveRetryableInstallFailure([guard], [{ skill_key: "review", status: "failed" }]),
		).toBe(false);
		expect(
			agentSkillsHaveRetryableInstallFailure([
				guard,
				{ ...guard, skill_key: "other", observation_error_code: "reconcile_failed" },
			]),
		).toBe(true);
		expect(
			agentSkillsHaveRetryableInstallFailure([guard], [{ skill_key: "other", status: "failed" }]),
		).toBe(true);
	},
);

test("retry banner retains ordinary Cloud and workspace failures", () => {
	expect(agentSkillsHaveRetryableInstallFailure([])).toBe(false);
	expect(
		agentSkillsHaveRetryableInstallFailure([], [{ skill_key: "review", status: "requested" }]),
	).toBe(false);
	expect(
		agentSkillsHaveRetryableInstallFailure([], [{ skill_key: "review", status: "failed" }]),
	).toBe(true);
	expect(
		agentSkillsHaveRetryableInstallFailure([
			{
				skill_key: "review",
				source: "project",
				convergence: "failed",
				observation_error_code: "reconcile_failed",
			},
		]),
	).toBe(true);
});

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
		).rejects.toThrow("did not match the requested project");

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
		).rejects.toThrow("ended before every project row was loaded");

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
		).rejects.toThrow("Too many agent skill pages");
	});
});
