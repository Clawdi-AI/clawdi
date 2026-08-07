import { describe, expect, test } from "bun:test";
import { buildAppBreadcrumbTrail } from "@/components/app-breadcrumb-model";
import type { BreadcrumbSegmentTitles } from "@/components/breadcrumb-title";

const agentId = "agent-1";
const workspaceId = "workspace-1";
const projectId = "project-1";
const deploymentSearch = { source: "on-clawdi", d: "deployment-1" };

function labels(
	pathname: string,
	{
		search = {},
		title = null,
		segmentTitles = {},
	}: {
		search?: Record<string, string>;
		title?: string | null;
		segmentTitles?: BreadcrumbSegmentTitles;
	} = {},
) {
	return buildAppBreadcrumbTrail({
		pathname,
		search,
		overrideTitle: title,
		segmentTitles: {
			[`/agents/${agentId}`]: { title: "e2e-2" },
			...segmentTitles,
		},
	}).map((item) => item.label);
}

describe("AppBreadcrumb semantic trail", () => {
	test("omits the implicit Workspace layer from Agent breadcrumbs", () => {
		const segmentTitles = {
			[`/agents/${agentId}/project-access/${workspaceId}`]: {
				title: "Workspace",
				context: "workspace" as const,
			},
		};
		expect(labels(`/agents/${agentId}/project-access/${workspaceId}`, { segmentTitles })).toEqual([
			"e2e-2",
		]);
		expect(
			labels(`/agents/${agentId}/project-access/${workspaceId}/skills`, {
				segmentTitles,
			}),
		).toEqual(["e2e-2", "Skills"]);
	});

	test("keeps linked Projects in the Projects hierarchy", () => {
		expect(
			labels(`/agents/${agentId}/project-access/${projectId}/vaults`, {
				segmentTitles: {
					[`/agents/${agentId}/project-access/${projectId}`]: { title: "Team Knowledge" },
				},
			}),
		).toEqual(["e2e-2", "Projects", "Team Knowledge", "Vaults"]);
	});

	test("does not mistake a linked Project named Workspace for the Agent Workspace", () => {
		expect(
			labels(`/agents/${agentId}/project-access/${projectId}`, {
				segmentTitles: {
					[`/agents/${agentId}/project-access/${projectId}`]: { title: "Workspace" },
				},
			}),
		).toEqual(["e2e-2", "Projects", "Workspace"]);
	});

	test("shows real Skill and Vault names in their selected Project context", () => {
		const segmentTitles = {
			[`/agents/${agentId}/project-access/${workspaceId}`]: {
				title: "Workspace",
				context: "workspace" as const,
			},
		};
		expect(
			labels(`/agents/${agentId}/skills/github%2Fissues`, {
				search: { ...deploymentSearch, project: workspaceId },
				title: "GitHub Issues",
				segmentTitles,
			}),
		).toEqual(["e2e-2", "Skills", "GitHub Issues"]);
		expect(
			labels(`/agents/${agentId}/vaults/production`, {
				search: { ...deploymentSearch, project: workspaceId },
				title: "Production Keys",
				segmentTitles,
			}),
		).toEqual(["e2e-2", "Vaults", "Production Keys"]);
	});

	test("shows real names for Agent-level resources", () => {
		expect(labels(`/agents/${agentId}/sessions/session-1`, { title: "Deploy the API" })).toEqual([
			"e2e-2",
			"Sessions",
			"Deploy the API",
		]);
		expect(
			labels(`/agents/${agentId}/memories/memory-1`, { title: "Prefers concise replies" }),
		).toEqual(["e2e-2", "Memories", "Prefers concise replies"]);
		expect(labels(`/agents/${agentId}/connectors/github`, { title: "GitHub" })).toEqual([
			"e2e-2",
			"Connectors",
			"GitHub",
		]);
	});

	test("preserves Hosted deployment context in every Agent parent link", () => {
		const trail = buildAppBreadcrumbTrail({
			pathname: `/agents/${agentId}/skills/github%2Fissues`,
			search: { ...deploymentSearch, project: workspaceId },
			overrideTitle: "GitHub Issues",
			segmentTitles: {
				[`/agents/${agentId}`]: { title: "e2e-2" },
				[`/agents/${agentId}/project-access/${workspaceId}`]: {
					title: "Workspace",
					context: "workspace",
				},
			},
		});
		expect(trail.filter((item) => item.href).map((item) => item.href)).toEqual([
			`/agents/${agentId}?source=on-clawdi&d=deployment-1`,
			`/agents/${agentId}/project-access/${workspaceId}/skills?source=on-clawdi&d=deployment-1`,
		]);
	});

	test("holds a stable placeholder instead of guessing or exposing an unavailable name", () => {
		expect(labels("/projects/550e8400-e29b-41d4-a716-446655440000")).toEqual(["Projects", null]);
		expect(
			labels(`/agents/${agentId}/vaults/internal-slug`, { search: { project: projectId } }),
		).toEqual(["e2e-2", "Vaults", null]);
	});
});
