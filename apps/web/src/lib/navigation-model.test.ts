import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FolderKanban, LayoutDashboard, MessageSquare, Settings, Zap } from "lucide-react";
import { PROJECT_RESOURCE_ICONS } from "@/components/project-resource-icons";
import {
	AGENT_SECTION_NAVIGATION_ITEMS,
	agentNavigationGroups,
	CONNECTED_AGENT_SECTION_IDS,
	CONSOLE_NAVIGATION_ITEMS,
	consoleCommandPaletteItems,
	consoleNavigationGroups,
	HOSTED_AGENT_SECTION_IDS,
} from "@/lib/navigation-model";

function groupShape(
	groups: ReadonlyArray<{
		id: string;
		label: string;
		items: ReadonlyArray<{ id: string; label: string }>;
	}>,
) {
	return groups.map((group) => ({
		id: group.id,
		label: group.label,
		items: group.items.map((item) => ({ id: item.id, label: item.label })),
	}));
}

describe("sidebar navigation model", () => {
	test("groups the full Console inventory by account semantics", () => {
		expect(groupShape(consoleNavigationGroups(true))).toEqual([
			{
				id: "primary",
				label: "Primary",
				items: [
					{ id: "overview", label: "Overview" },
					{ id: "agents", label: "Agents" },
				],
			},
			{
				id: "projects",
				label: "Projects",
				items: [
					{ id: "projects", label: "Projects" },
					{ id: "skills", label: "Skills" },
					{ id: "vaults", label: "Vaults" },
				],
			},
			{
				id: "activity",
				label: "Activity",
				items: [
					{ id: "sessions", label: "Sessions" },
					{ id: "memories", label: "Memories" },
				],
			},
			{
				id: "integrations",
				label: "Integrations",
				items: [
					{ id: "connectors", label: "Connectors" },
					{ id: "channels", label: "Channels" },
					{ id: "ai-providers", label: "AI Providers" },
				],
			},
		]);
	});

	test("preserves hosted gating in the Console and command palette", () => {
		const ossGroups = consoleNavigationGroups(false);
		expect(ossGroups.at(-1)?.items.map((item) => item.id)).toEqual(["connectors"]);
		expect(consoleCommandPaletteItems(false).map((item) => item.id)).toEqual([
			"overview",
			"projects",
			"skills",
			"vaults",
			"sessions",
			"memories",
			"connectors",
		]);
		expect(
			consoleCommandPaletteItems(true)
				.filter((item) => item.availability === "cloud")
				.map((item) => item.id),
		).toEqual(["channels", "ai-providers"]);
	});

	test("uses one ordered grammar for connected and hosted agents", () => {
		expect(groupShape(agentNavigationGroups("connected"))).toEqual([
			{ id: "primary", label: "Primary", items: [{ id: "overview", label: "Overview" }] },
			{ id: "activity", label: "Activity", items: [{ id: "sessions", label: "Sessions" }] },
			{
				id: "context",
				label: "Context",
				items: [
					{ id: "skills", label: "Skills" },
					{ id: "projects", label: "Projects" },
				],
			},
			{ id: "manage", label: "Manage", items: [{ id: "settings", label: "Settings" }] },
		]);
		expect(groupShape(agentNavigationGroups("hosted"))).toEqual([
			{ id: "primary", label: "Primary", items: [{ id: "overview", label: "Overview" }] },
			{
				id: "runtime",
				label: "Runtime",
				items: [
					{ id: "console", label: "Agent Interface" },
					{ id: "terminal", label: "Terminal" },
				],
			},
			{ id: "activity", label: "Activity", items: [{ id: "sessions", label: "Sessions" }] },
			{ id: "context", label: "Context", items: [{ id: "skills", label: "Skills" }] },
			{
				id: "integrations",
				label: "Integrations",
				items: [
					{ id: "ai", label: "AI & Model" },
					{ id: "channels", label: "Channels" },
				],
			},
			{ id: "manage", label: "Manage", items: [{ id: "settings", label: "Settings" }] },
		]);
		expect(CONNECTED_AGENT_SECTION_IDS).toEqual([
			"overview",
			"sessions",
			"skills",
			"projects",
			"settings",
		]);
		expect(HOSTED_AGENT_SECTION_IDS).toEqual([
			"overview",
			"console",
			"terminal",
			"sessions",
			"skills",
			"ai",
			"channels",
			"settings",
		]);
	});

	test("keeps labels, icons, and descriptions canonical across navigation and page headers", () => {
		expect(AGENT_SECTION_NAVIGATION_ITEMS.overview).toMatchObject({
			label: "Overview",
			icon: LayoutDashboard,
			description: "Status, resources, and recent activity for this agent.",
		});
		expect(AGENT_SECTION_NAVIGATION_ITEMS.sessions.icon).toBe(MessageSquare);
		expect(AGENT_SECTION_NAVIGATION_ITEMS.projects).toMatchObject({
			label: "Projects",
			icon: FolderKanban,
		});
		expect(AGENT_SECTION_NAVIGATION_ITEMS.ai).toMatchObject({
			label: "AI & Model",
			icon: Zap,
			description: "Provider binding and primary model used by this agent.",
		});
		expect(AGENT_SECTION_NAVIGATION_ITEMS.settings.icon).toBe(Settings);
		expect(CONSOLE_NAVIGATION_ITEMS.projects.icon).toBe(PROJECT_RESOURCE_ICONS.projects);

		const connectedDetail = readFileSync(
			new URL("../components/dashboard/connected-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		const hostedDetail = readFileSync(
			new URL("../hosted/agents/hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		expect(connectedDetail).toContain("AGENT_SECTION_NAVIGATION_ITEMS[activeTab]");
		expect(hostedDetail).toContain("AGENT_SECTION_NAVIGATION_ITEMS[activeTab]");
		expect(connectedDetail).not.toContain("AGENT_DETAIL_NAV_META");
		expect(hostedDetail).not.toContain("HOSTED_AGENT_NAV_META");
	});
});
