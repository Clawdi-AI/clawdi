import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Settings } from "lucide-react";
import {
	AGENT_SECTION_NAVIGATION_ITEMS,
	agentNavigationGroups,
	CONNECTED_AGENT_SECTION_IDS,
	CONSOLE_NAVIGATION_ITEMS,
	consoleCommandPaletteItems,
	consoleNavigationGroups,
	HOSTED_AGENT_SECTION_IDS,
	hostedAgentVisibleSectionIds,
} from "@/lib/navigation-model";

function groupShape(
	groups: ReadonlyArray<{
		id: string;
		label: string | null;
		separated: boolean;
		items: ReadonlyArray<{ id: string; label: string }>;
	}>,
) {
	return groups.map((group) => ({
		id: group.id,
		label: group.label,
		separated: group.separated,
		items: group.items.map((item) => ({ id: item.id, label: item.label })),
	}));
}

function expectNavigationHeadings(
	groups: ReadonlyArray<{ label: string | null; items: readonly unknown[] }>,
	expected = ["Library"],
) {
	expect(groups.filter((group) => group.label !== null).map((group) => group.label)).toEqual(
		expected,
	);
	expect(groups.every((group) => group.items.length > 0)).toBe(true);
}

describe("sidebar navigation model", () => {
	test("locks the Console blocks and cloud-gated resource order", () => {
		const cloudGroups = consoleNavigationGroups(true);
		expect(groupShape(cloudGroups)).toEqual([
			{
				id: "primary",
				label: null,
				separated: false,
				items: [
					{ id: "overview", label: "Overview" },
					{ id: "agents", label: "Agents" },
					{ id: "sessions", label: "Sessions" },
					{ id: "memories", label: "Memories" },
				],
			},
			{
				id: "library",
				label: "Library",
				separated: false,
				items: [
					{ id: "projects", label: "Projects" },
					{ id: "skills", label: "Skills" },
					{ id: "vaults", label: "Vaults" },
					{ id: "connectors", label: "Connectors" },
					{ id: "channels", label: "Channels" },
					{ id: "ai-providers", label: "AI Providers" },
				],
			},
		]);
		expectNavigationHeadings(cloudGroups);

		const ossGroups = consoleNavigationGroups(false);
		expect(ossGroups[1]?.items.map((item) => item.id)).toEqual([
			"projects",
			"skills",
			"vaults",
			"connectors",
		]);
		expectNavigationHeadings(ossGroups);
	});

	test("preserves command palette availability in the rendered navigation order", () => {
		expect(consoleCommandPaletteItems(false).map((item) => item.id)).toEqual([
			"overview",
			"sessions",
			"memories",
			"projects",
			"skills",
			"vaults",
			"connectors",
		]);
		expect(consoleCommandPaletteItems(true).map((item) => item.id)).toEqual([
			"overview",
			"sessions",
			"memories",
			"projects",
			"skills",
			"vaults",
			"connectors",
			"channels",
			"ai-providers",
		]);
	});

	test("separates one Agent's workspace from account-wide shared resources", () => {
		const connectedGroups = agentNavigationGroups("connected");
		expect(groupShape(connectedGroups)).toEqual([
			{
				id: "primary",
				label: null,
				separated: false,
				items: [
					{ id: "overview", label: "Overview" },
					{ id: "sessions", label: "Sessions" },
				],
			},
			{
				id: "workspace",
				label: "Workspace",
				separated: false,
				items: [{ id: "projects", label: "Projects" }],
			},
			{
				id: "shared",
				label: "Shared",
				separated: false,
				items: [
					{ id: "memories", label: "Memories" },
					{ id: "connectors", label: "Connectors" },
				],
			},
			{
				id: "settings",
				label: null,
				separated: true,
				items: [{ id: "settings", label: "Settings" }],
			},
		]);
		expectNavigationHeadings(connectedGroups, ["Workspace", "Shared"]);

		const hostedGroups = agentNavigationGroups("hosted");
		expect(groupShape(hostedGroups)).toEqual([
			{
				id: "primary",
				label: null,
				separated: false,
				items: [
					{ id: "overview", label: "Overview" },
					{ id: "sessions", label: "Sessions" },
				],
			},
			{
				id: "workspace",
				label: "Workspace",
				separated: false,
				items: [{ id: "projects", label: "Projects" }],
			},
			{
				id: "shared",
				label: "Shared",
				separated: false,
				items: [
					{ id: "memories", label: "Memories" },
					{ id: "connectors", label: "Connectors" },
				],
			},
			{
				id: "operate",
				label: "Tools",
				separated: false,
				items: [
					{ id: "console", label: "Agent Interface" },
					{ id: "files", label: "Files" },
					{ id: "terminal", label: "Terminal" },
					{ id: "plugins", label: "Plugins" },
					{ id: "channels", label: "Channels" },
					{ id: "ai", label: "AI Providers" },
				],
			},
			{
				id: "settings",
				label: null,
				separated: true,
				items: [{ id: "settings", label: "Settings" }],
			},
		]);
		expectNavigationHeadings(hostedGroups, ["Workspace", "Shared", "Tools"]);

		expect(CONNECTED_AGENT_SECTION_IDS).toEqual([
			"overview",
			"sessions",
			"projects",
			"memories",
			"connectors",
			"settings",
		]);
		expect(HOSTED_AGENT_SECTION_IDS).toEqual([
			"overview",
			"sessions",
			"projects",
			"memories",
			"connectors",
			"console",
			"files",
			"terminal",
			"plugins",
			"channels",
			"ai",
			"settings",
		]);
		expect(hostedAgentVisibleSectionIds(false)).not.toContain("files");
		expect(hostedAgentVisibleSectionIds(true)).toContain("files");

		expect(groupShape(agentNavigationGroups("hosted", ["overview"]))).toEqual([
			{
				id: "primary",
				label: null,
				separated: false,
				items: [{ id: "overview", label: "Overview" }],
			},
		]);
	});

	test("uses exactly the same visible label and icon for overlapping concepts", () => {
		const pairs = [
			["overview", "overview"],
			["sessions", "sessions"],
			["memories", "memories"],
			["skills", "skills"],
			["projects", "projects"],
			["vaults", "vaults"],
			["connectors", "connectors"],
			["channels", "channels"],
			["ai", "ai-providers"],
		] as const;
		for (const [agentId, consoleId] of pairs) {
			expect(AGENT_SECTION_NAVIGATION_ITEMS[agentId].label).toBe(
				CONSOLE_NAVIGATION_ITEMS[consoleId].label,
			);
			expect(AGENT_SECTION_NAVIGATION_ITEMS[agentId].icon).toBe(
				CONSOLE_NAVIGATION_ITEMS[consoleId].icon,
			);
		}
		expect(AGENT_SECTION_NAVIGATION_ITEMS.ai.description).toBe(
			"AI provider and primary model used by this agent.",
		);
		expect(AGENT_SECTION_NAVIGATION_ITEMS.memories.description).toBe(
			"Memories are shared across all agents.",
		);
		expect(AGENT_SECTION_NAVIGATION_ITEMS.settings.icon).toBe(Settings);
	});

	test("shares direct resource panels and keeps Project resources on the Project hub", () => {
		const connectedDetail = readFileSync(
			new URL("../components/dashboard/connected-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		const hostedDetail = readFileSync(
			new URL("../hosted/agents/hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		const agentVaultsTab = readFileSync(
			new URL("../components/dashboard/agent-vaults-tab.tsx", import.meta.url),
			"utf8",
		);
		const memoriesPage = readFileSync(
			new URL("../pages/dashboard/memories/page.tsx", import.meta.url),
			"utf8",
		);
		const connectorsPage = readFileSync(
			new URL("../pages/dashboard/connectors/page.tsx", import.meta.url),
			"utf8",
		);
		const vaultPage = readFileSync(
			new URL("../pages/dashboard/vault/page.tsx", import.meta.url),
			"utf8",
		);
		const overviewBodies = readFileSync(
			new URL("../components/dashboard/agent-overview-resource-bodies.tsx", import.meta.url),
			"utf8",
		);
		for (const source of [connectedDetail, hostedDetail]) {
			expect(source).toContain("AGENT_SECTION_NAVIGATION_ITEMS[activeTab]");
			expect(source).toContain("<AgentProjectsTab");
			expect(source).not.toContain("<AgentSkillsTab");
			expect(source).not.toContain("<AgentVaultsTab");
			expect(source).toContain("<ConnectorsSurface embedded");
			expect(source).toContain("<MemoriesSurface");
			expect(source).not.toContain("@/pages/dashboard");
		}
		expect(agentVaultsTab).toContain("@/components/vault/vaults-surface");
		expect(agentVaultsTab).not.toContain("@/pages/dashboard");
		expect(connectorsPage).toContain("@/components/connectors/connectors-surface");
		expect(connectorsPage).not.toContain("useQuery");
		expect(vaultPage).toContain("@/components/vault/vaults-surface");
		expect(vaultPage).not.toContain("useQuery");
		expect(memoriesPage).toContain("@/components/memories/memories-surface");
		expect(memoriesPage).not.toContain("useQuery");
		expect(overviewBodies).toContain("useOverviewMemoriesModule");
		expect(overviewBodies).toContain("useOverviewConnectorsModule");
		expect(connectedDetail).not.toContain("function AgentProjectsPanel");
	});
});
