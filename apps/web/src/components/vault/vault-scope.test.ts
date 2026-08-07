import { describe, expect, test } from "bun:test";
import type { components } from "@/lib/api-schemas";
import {
	effectiveAgentProjectIds,
	fetchAgentProjectVaults,
	vaultsForProjectIds,
	vaultsForSelectedProject,
} from "./vault-scope";

type Binding = components["schemas"]["AgentProjectBindingResponse"];
type Vault = components["schemas"]["VaultResponse"];

function binding(
	id: string,
	projectId: string,
	bindingType: "primary" | "context",
	priority: number,
): Binding {
	return {
		id,
		agent_id: "agent_1",
		project_id: projectId,
		binding_type: bindingType,
		priority,
		default_write_enabled: bindingType === "primary",
		created_at: "2026-08-01T00:00:00Z",
	};
}

function vault(id: string, projectIds: string[]): Vault {
	return {
		id,
		slug: id,
		name: id,
		project_ids: projectIds,
		is_owner: true,
		item_count: 1,
		created_at: "2026-08-01T00:00:00Z",
	};
}

describe("agent Vault scope", () => {
	test("filters the canonical Vault inventory by its URL-selected Project", () => {
		const vaults = [
			vault("primary-vault", ["project_primary"]),
			vault("shared-vault", ["project_primary", "project_context"]),
			vault("context-vault", ["project_context"]),
		];

		expect(vaultsForSelectedProject(vaults, "project_primary").map((item) => item.id)).toEqual([
			"primary-vault",
			"shared-vault",
		]);
		expect(vaultsForSelectedProject(vaults, "all")).toEqual(vaults);
	});

	test("orders the primary Project before ordered context bindings and deduplicates ids", () => {
		expect(
			effectiveAgentProjectIds([
				binding("context-2", "project_context_2", "context", 2),
				binding("primary", "project_primary", "primary", 0),
				binding("context-1", "project_context_1", "context", 1),
				binding("duplicate", "project_context_1", "context", 3),
			]),
		).toEqual(["project_primary", "project_context_1", "project_context_2"]);
	});

	test("returns only Vaults attached to the agent's effective Project set", () => {
		const visible = vaultsForProjectIds(
			[
				vault("primary-vault", ["project_primary"]),
				vault("context-vault", ["project_other", "project_context"]),
				vault("unrelated-vault", ["project_other"]),
				vault("unattached-vault", []),
			],
			["project_primary", "project_context"],
		);

		expect(visible.map((item) => item.id)).toEqual(["primary-vault", "context-vault"]);
		expect(vaultsForProjectIds([vault("private", ["project_other"])], [])).toEqual([]);
	});

	test("walks every server-filtered page for each effective Project", async () => {
		const calls: Array<{ projectId: string; page: number; pageSize: number }> = [];
		const result = await fetchAgentProjectVaults(
			["project_primary"],
			async (projectId, page, pageSize) => {
				calls.push({ projectId, page, pageSize });
				return {
					items:
						page === 1
							? [vault("first", [projectId]), vault("second", [projectId])]
							: [vault("target-after-first-page", [projectId])],
					total: 3,
					page,
					page_size: pageSize,
				};
			},
			{ pageSize: 2 },
		);

		expect(calls).toEqual([
			{ projectId: "project_primary", page: 1, pageSize: 2 },
			{ projectId: "project_primary", page: 2, pageSize: 2 },
		]);
		expect(result.map((item) => item.id)).toEqual(["first", "second", "target-after-first-page"]);
	});

	test("deduplicates a shared Vault across Project-filtered inventories", async () => {
		const result = await fetchAgentProjectVaults(
			["project_primary", "project_context"],
			async (projectId, page, pageSize) => ({
				items:
					projectId === "project_primary"
						? [vault("shared", [projectId]), vault("primary-only", [projectId])]
						: [vault("shared", [projectId])],
				total: projectId === "project_primary" ? 2 : 1,
				page,
				page_size: pageSize,
			}),
			{ pageSize: 2 },
		);

		expect(result.map((item) => item.id)).toEqual(["shared", "primary-only"]);
		expect(result[0]?.project_ids).toEqual(["project_primary", "project_context"]);
	});

	test("throws instead of returning a truncated Agent Vault inventory", async () => {
		await expect(
			fetchAgentProjectVaults(
				["project_primary"],
				async (projectId, page, pageSize) => ({
					items: [vault(`page-${page}`, [projectId])],
					total: 2,
					page,
					page_size: pageSize,
				}),
				{ pageSize: 1, maxPages: 1 },
			),
		).rejects.toThrow("Too many agent Vault pages");
	});
});
