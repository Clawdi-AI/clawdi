import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import type { AgentMcpInventory } from "./hosted-agent-mcp";
import {
	agentMcpInventoryMatchesDeployment,
	agentMcpInventoryQueryEnabled,
	agentMcpInventoryQueryKey,
	agentMcpInventoryRefetchInterval,
	mcpRuntimeHealthForDeployment,
} from "./hosted-agent-mcp";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function inventory(
	availability: AgentMcpInventory["availability"],
	servers: AgentMcpInventory["servers"] = [],
	deploymentId: string | null = "deployment-1",
): AgentMcpInventory {
	return { agent_id: AGENT_ID, deployment_id: deploymentId, availability, servers };
}

describe("Hosted MCP page boundary", () => {
	test("renders only the generated safe inventory and one overall health fence", () => {
		const source = readFileSync(new URL("./hosted-agent-mcp-tab.tsx", import.meta.url), "utf8");
		const generated = readFileSync(
			new URL("../../../../../packages/shared/src/api/api.generated.ts", import.meta.url),
			"utf8",
		);
		const schemaStart = generated.indexOf("AgentMcpInventoryResponse:");
		const schemaEnd = generated.indexOf("AgentProjectBindingResponse:", schemaStart);
		const schema = generated.slice(schemaStart, schemaEnd);
		expect(source).toContain('api.GET("/v1/agents/{agent_id}/mcp"');
		expect(source).toContain("mcpRuntimeHealthForDeployment(runtimeObserved.data, deploymentId)");
		expect(source).toContain("runtimeEvidenceFence");
		expect(source).toContain("refetchIntervalInBackground: false");
		expect(source).not.toMatch(/observed_config_generation|desired_config_generation/);
		expect(source).not.toMatch(/server\.convergence/);
		expect(source).toContain("sourceLabel(server.source)");
		expect(source).not.toMatch(/deployment\.resource\.spec\.skills|manifestSkill/);
		for (const sensitive of [
			"server.url",
			"server.headers",
			"server.secret",
			"server.command",
			"server.args",
			"server.env",
		]) {
			expect(source).not.toContain(sensitive);
		}
		expect(schema).toMatch(/id: string[\s\S]*transport:[\s\S]*enabled: boolean[\s\S]*source:/);
		expect(schema).not.toMatch(/\b(url|headers|secretRef|command|args|env)\b/i);
	});

	test("rejects overall runtime health from a replaced deployment", () => {
		const runtime: NonNullable<Parameters<typeof mcpRuntimeHealthForDeployment>[0]> = {
			environment: {
				id: AGENT_ID,
				name: "Agent",
				machine_name: "Agent",
				sort_order: 0,
				agent_type: "openclaw",
				agent_version: null,
				os: "linux",
				last_seen_at: null,
				queue_depth_high_water: 0,
				dropped_count: 0,
				sync_enabled: false,
				explicit_identity: true,
				hosted_managed: true,
				default_project_id: "project-1",
			},
			desired: {
				deployment_id: "deployment-old",
				instance_id: "instance-old",
				desired_config_generation: 1,
				enabled_runtimes: ["openclaw"],
				has_mcp: true,
				has_tools: false,
				managed_skills: [],
			},
			observed: { observed_config_generation: 1 },
			health: { status: "ok", reasons: [] },
			provider_health: [],
		};
		expect(mcpRuntimeHealthForDeployment(runtime, "deployment-current")).toBeUndefined();
		expect(mcpRuntimeHealthForDeployment(runtime, "deployment-old")?.status).toBe("ok");
	});

	test("distinguishes unavailable desired state from a configured empty inventory", () => {
		const source = readFileSync(new URL("./hosted-agent-mcp-tab.tsx", import.meta.url), "utf8");
		expect(agentMcpInventoryMatchesDeployment(inventory("unavailable"), "deployment-1")).toBe(
			false,
		);
		expect(agentMcpInventoryMatchesDeployment(inventory("available"), "deployment-1")).toBe(true);
		expect(source).toContain("No deployment-managed MCP servers");
		expect(source).toContain("Runtime convergence unavailable");
	});

	test("rejects available MCP inventory from a replaced deployment", () => {
		expect(agentMcpInventoryMatchesDeployment(inventory("available"), "deployment-1")).toBe(true);
		expect(agentMcpInventoryMatchesDeployment(inventory("available"), "deployment-2")).toBe(false);
		expect(
			agentMcpInventoryMatchesDeployment(inventory("available", [], null), "deployment-1"),
		).toBe(false);
		expect(agentMcpInventoryMatchesDeployment(inventory("unavailable"), "deployment-1")).toBe(
			false,
		);
	});

	test("refetches desired inventory when the same Agent receives a new deployment fence", async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const requests: string[] = [];
		const fetchInventory = async (
			fence: string,
			response: AgentMcpInventory,
		): Promise<AgentMcpInventory> =>
			queryClient.fetchQuery({
				queryKey: agentMcpInventoryQueryKey(AGENT_ID, fence),
				staleTime: Number.POSITIVE_INFINITY,
				queryFn: async () => {
					requests.push(fence);
					return response;
				},
			});

		expect(await fetchInventory("rv-1", inventory("unavailable"))).toMatchObject({
			availability: "unavailable",
		});
		// An identical snapshot reuses only its own cache entry.
		expect(await fetchInventory("rv-1", inventory("available"))).toMatchObject({
			availability: "unavailable",
		});
		expect(await fetchInventory("rv-2", inventory("available"))).toEqual(inventory("available"));
		expect(
			await fetchInventory(
				"rv-3",
				inventory("available", [
					{
						id: "docs",
						transport: "streamable-http",
						enabled: true,
						source: "deployment_manifest",
					},
				]),
			),
		).toMatchObject({ availability: "available", servers: [{ id: "docs" }] });
		expect(requests).toEqual(["rv-1", "rv-2", "rv-3"]);
	});

	test("polls unavailable, empty, and non-empty desired inventory without claiming convergence", () => {
		expect(agentMcpInventoryRefetchInterval(inventory("unavailable"))).toBe(2_000);
		expect(agentMcpInventoryRefetchInterval(inventory("available"))).toBe(10_000);
		expect(
			agentMcpInventoryRefetchInterval(
				inventory("available", [
					{ id: "local", transport: "stdio", enabled: true, source: "deployment_manifest" },
				]),
			),
		).toBe(10_000);
	});

	test("does not reuse an available cache entry for disabled, foreign, or missing identities", () => {
		const queryClient = new QueryClient();
		const currentKey = agentMcpInventoryQueryKey(AGENT_ID, "rv-current");
		queryClient.setQueryData(currentKey, inventory("available"));

		expect(agentMcpInventoryQueryEnabled(AGENT_ID)).toBe(true);
		expect(agentMcpInventoryQueryEnabled("deployment-not-an-agent-id")).toBe(false);
		expect(
			queryClient.getQueryData(
				agentMcpInventoryQueryKey("22222222-2222-4222-8222-222222222222", "rv-current"),
			),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(agentMcpInventoryQueryKey(AGENT_ID, "rv-missing")),
		).toBeUndefined();
	});

	test("keeps MCP navigation and content stable without a live Agent projection", () => {
		const detail = readFileSync(new URL("./hosted-agent-detail.tsx", import.meta.url), "utf8");
		const sidebar = readFileSync(
			new URL("../../components/app-sidebar.tsx", import.meta.url),
			"utf8",
		);
		expect(detail).toContain('{activeTab === "mcp" ? (');
		expect(detail).not.toMatch(
			/activeTab === "mcp"[\s\S]{0,200}!deploymentProjectionQueryable[\s\S]{0,100}StoppedAgentState/,
		);
		expect(sidebar).toContain(
			'section.id === "overview" || section.id === "skills" || section.id === "mcp"',
		);
	});
});
