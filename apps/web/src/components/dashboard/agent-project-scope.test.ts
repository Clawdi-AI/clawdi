import { describe, expect, test } from "bun:test";
import type { components } from "@/lib/api-schemas";
import {
	effectiveAgentProjectIds,
	linkedAgentProjectCount,
	orderedAgentProjectBindings,
	resolveAgentDefaultProject,
	resolveAgentProjectScope,
} from "./agent-project-scope";

type Binding = components["schemas"]["AgentProjectBindingResponse"];

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
		created_at: `2026-08-01T00:00:0${priority}Z`,
	};
}

describe("effective Agent Project scope", () => {
	test("resolves only the accessible Project matching the single primary binding", () => {
		const bindings = [
			binding("primary", "project_primary", "primary", 0),
			binding("context", "project_context", "context", 1),
		];
		const projects = [
			{ id: "project_context", name: "Context" },
			{ id: "project_primary", name: "Default" },
		];

		expect(resolveAgentDefaultProject(bindings, projects, "project_primary")).toEqual(
			projects[1] ?? null,
		);
		expect(resolveAgentDefaultProject(bindings, projects, "project_context")).toBeNull();
		expect(resolveAgentDefaultProject(bindings, projects, null)).toBeNull();
	});

	test("never falls back when the primary binding is missing, duplicated, or inaccessible", () => {
		const accessibleFallback = [{ id: "project_context", name: "Context" }];

		expect(
			resolveAgentDefaultProject(
				[binding("context", "project_context", "context", 1)],
				accessibleFallback,
				"project_primary",
			),
		).toBeNull();
		expect(
			resolveAgentDefaultProject(
				[
					binding("primary-1", "project_primary", "primary", 0),
					binding("primary-2", "project_other", "primary", 0),
				],
				accessibleFallback,
				"project_primary",
			),
		).toBeNull();
		expect(
			resolveAgentDefaultProject(
				[binding("primary", "project_primary", "primary", 0)],
				accessibleFallback,
				"project_primary",
			),
		).toBeNull();
	});

	test("orders the fixed primary before context bindings in priority order", () => {
		const bindings = [
			binding("context-2", "project_context_2", "context", 2),
			binding("primary", "project_primary", "primary", 0),
			binding("context-1", "project_context_1", "context", 1),
		];

		expect(orderedAgentProjectBindings(bindings).map((item) => item.id)).toEqual([
			"primary",
			"context-1",
			"context-2",
		]);
		expect(effectiveAgentProjectIds(bindings)).toEqual([
			"project_primary",
			"project_context_1",
			"project_context_2",
		]);
		expect(linkedAgentProjectCount(bindings)).toBe(2);
	});

	test("uses AgentResponse.default_project_id only as a consistency fence", () => {
		const bindings = [
			binding("primary", "project_primary", "primary", 0),
			binding("context", "project_context", "context", 1),
		];

		expect(resolveAgentProjectScope(bindings, "project_primary").projectIds).toEqual([
			"project_primary",
			"project_context",
		]);
		expect(() => resolveAgentProjectScope(bindings, "project_stale")).toThrow(
			"Workspace is still syncing",
		);
		expect(() => resolveAgentProjectScope([], "project_primary")).toThrow(
			"Workspace is not available",
		);
		expect(() =>
			resolveAgentProjectScope(
				[binding("context", "project_primary", "context", 1)],
				"project_primary",
			),
		).toThrow("Workspace is not available");
		expect(() =>
			resolveAgentProjectScope(
				[
					binding("primary-1", "project_primary", "primary", 0),
					binding("primary-2", "project_other", "primary", 0),
				],
				"project_primary",
			),
		).toThrow("Workspace is not available");
	});
});
