import { describe, expect, it } from "bun:test";
import {
	agentConnectorDetailHref,
	agentConnectorDetailLink,
	agentMemoryDetailHref,
	agentMemoryDetailLink,
	agentProjectDetailHref,
	agentProjectDetailLink,
	agentProjectResourceHref,
	agentProjectResourceLink,
	agentRouteOwnsSection,
	agentRouteQueryString,
	agentRouteSearch,
	agentSectionHref,
	agentSectionLabel,
	agentSectionLabelFromSegment,
	agentSectionLink,
	agentSectionSegment,
	agentSessionDetailHref,
	agentSessionDetailLink,
	agentSkillDetailHref,
	agentSkillDetailLink,
	agentVaultDetailHref,
	agentVaultDetailLink,
	CONNECTED_AGENT_SECTION_IDS,
	HOSTED_AGENT_SECTION_IDS,
	isAgentRouteId,
	legacyAgentRoute,
	parseAgentPathname,
	parseAgentSectionSegment,
} from "./agent-routes";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

describe("agent routes", () => {
	it("builds canonical segment routes for agent sections", () => {
		expect(agentSectionHref("agent 1")).toBe("/agents/agent%201");
		expect(agentSectionHref("agent 1", "sessions")).toBe("/agents/agent%201/sessions");
		expect(agentSectionHref("agent 1", "memories")).toBe("/agents/agent%201/memories");
		expect(agentSectionHref("agent 1", "projects")).toBe("/agents/agent%201/project-access");
		expect(agentSectionHref("agent 1", "vaults")).toBe("/agents/agent%201/vaults");
		expect(agentSectionHref("agent 1", "connectors")).toBe("/agents/agent%201/connectors");
		expect(agentSectionHref("agent 1", "ai")).toBe("/agents/agent%201/model-provider");
		expect(agentSectionHref("agent 1", "channels")).toBe("/agents/agent%201/channel-links");
		expect(agentSectionHref("agent 1", "plugins")).toBe("/agents/agent%201/plugins");
		expect(agentSectionHref("agent 1", "files")).toBe("/agents/agent%201/files");
		expect(agentSectionHref("agent 1", "settings")).toBe("/agents/agent%201/settings");
		expect(agentSessionDetailHref("agent 1", "session 1")).toBe(
			"/agents/agent%201/sessions/session%201",
		);
		expect(agentMemoryDetailHref("agent 1", "memory 1")).toBe(
			"/agents/agent%201/memories/memory%201",
		);
		expect(agentConnectorDetailHref("agent 1", "google drive")).toBe(
			"/agents/agent%201/connectors/google%20drive",
		);
		expect(agentSkillDetailHref("agent 1", "team/foo", "proj 1")).toBe(
			"/agents/agent%201/skills/team/foo?project=proj%201",
		);
		expect(agentSkillDetailHref("agent 1", "team/foo")).toBe("/agents/agent%201/skills/team/foo");
		expect(agentProjectDetailHref("agent 1", "project 1")).toBe(
			"/agents/agent%201/project-access/project%201",
		);
		expect(agentProjectResourceHref("agent 1", "project 1", "skills")).toBe(
			"/agents/agent%201/project-access/project%201/skills",
		);
		expect(agentProjectResourceHref("agent 1", "project 1", "vaults")).toBe(
			"/agents/agent%201/project-access/project%201/vaults",
		);
		expect(agentVaultDetailHref("agent 1", "prod keys", "vault/1")).toBe(
			"/agents/agent%201/vaults/prod%20keys?vault=vault%2F1",
		);
	});

	it("drops unsupported tab query params when building section links", () => {
		expect(agentSectionHref("agent 1", "settings", "tab=settings&settings=billing-plan")).toBe(
			"/agents/agent%201/settings?settings=billing-plan",
		);
		expect(
			agentSectionHref("agent 1", "sessions", {
				tab: "sessions",
				tag: ["a", "b"],
				empty: undefined,
			}),
		).toBe("/agents/agent%201/sessions?tag=%5B%22a%22%2C%22b%22%5D");
	});

	it("uses TanStack's search serialization for additive typed state", () => {
		expect(
			agentSectionHref("agent 1", "sessions", {
				topup_return: 1,
				confirmed: true,
				filter: { status: "ready" },
			}),
		).toBe(
			"/agents/agent%201/sessions?topup_return=1&confirmed=true&filter=%7B%22status%22%3A%22ready%22%7D",
		);
	});

	it("keeps every Agent route producer UUID-based and strips obsolete identity state", () => {
		const legacySearch = "source=on-clawdi&d=hdep_selected&tab=settings&keep=value";
		const hrefs = [
			agentSectionHref(AGENT_ID, "overview", legacySearch),
			agentSessionDetailHref(AGENT_ID, "session 1", legacySearch),
			agentSkillDetailHref(AGENT_ID, "team/foo", "project 1", legacySearch),
			agentProjectDetailHref(AGENT_ID, "project 1", legacySearch),
			agentProjectResourceHref(AGENT_ID, "project 1", "skills", legacySearch),
			agentProjectResourceHref(AGENT_ID, "project 1", "vaults", legacySearch),
			agentVaultDetailHref(AGENT_ID, "prod keys", "vault/1", legacySearch),
			agentMemoryDetailHref(AGENT_ID, "memory 1", legacySearch),
			agentConnectorDetailHref(AGENT_ID, "google drive", legacySearch),
		];
		const links = [
			agentSectionLink(AGENT_ID, "overview", legacySearch),
			agentSessionDetailLink(AGENT_ID, "session 1", legacySearch),
			agentSkillDetailLink(AGENT_ID, "team/foo", "project 1", legacySearch),
			agentProjectDetailLink(AGENT_ID, "project 1", legacySearch),
			agentProjectResourceLink(AGENT_ID, "project 1", "skills", legacySearch),
			agentProjectResourceLink(AGENT_ID, "project 1", "vaults", legacySearch),
			agentVaultDetailLink(AGENT_ID, "prod keys", "vault/1", legacySearch),
			agentMemoryDetailLink(AGENT_ID, "memory 1", legacySearch),
			agentConnectorDetailLink(AGENT_ID, "google drive", legacySearch),
		];

		for (const href of hrefs) {
			expect(href.startsWith(`/agents/${AGENT_ID}`)).toBe(true);
			expect(href).not.toContain("source=");
			expect(href).not.toContain("d=");
			expect(href).not.toContain("tab=");
			expect(href).toContain("keep=value");
		}
		for (const link of links) {
			expect(link.params.id).toBe(AGENT_ID);
			expect(link.search).toMatchObject({ keep: "value" });
			expect(link.search).not.toHaveProperty("source");
			expect(link.search).not.toHaveProperty("d");
			expect(link.search).not.toHaveProperty("tab");
		}
		expect(agentRouteSearch(legacySearch)).toEqual({ keep: "value" });
		expect(isAgentRouteId(AGENT_ID)).toBe(true);
		expect(isAgentRouteId("hdep_selected")).toBe(false);
	});

	it("lets only the complete current section route own canonicalization", () => {
		expect(agentRouteOwnsSection("/agents/AGENT-1/skills", "agent-1", "skills")).toBe(true);
		expect(agentRouteOwnsSection("/agents/agent-1", "agent-1", "overview")).toBe(true);
		expect(agentRouteOwnsSection("/agents/agent-1/sessions/s-1", "agent-1", "sessions")).toBe(
			false,
		);
		expect(agentRouteOwnsSection("/agents/agent-1/skills/team/foo", "agent-1", "skills")).toBe(
			false,
		);
		expect(
			agentRouteOwnsSection("/agents/agent-1/project-access/project-1", "agent-1", "projects"),
		).toBe(false);
		expect(agentRouteOwnsSection("/agents/agent-1/vaults/prod", "agent-1", "vaults")).toBe(false);
		expect(agentRouteOwnsSection("/agents/agent-1/memories/memory-1", "agent-1", "memories")).toBe(
			false,
		);
		expect(
			agentRouteOwnsSection("/agents/agent-1/connectors/github", "agent-1", "connectors"),
		).toBe(false);
		expect(agentRouteOwnsSection("/agents/agent-1/skills", "agent-1", "overview")).toBe(false);
	});

	it("owns canonical section navigation with typed Router options", () => {
		expect(agentSectionLink("agent 1", "overview", { keep: "value" })).toEqual({
			to: "/agents/$id",
			params: { id: "agent 1" },
			search: { keep: "value" },
		});
		expect(agentSectionLink("agent 1", "skills", { keep: "value" })).toEqual({
			to: "/agents/$id/skills",
			params: { id: "agent 1" },
			search: { keep: "value" },
		});
		expect(agentSectionLink("agent 1", "channels", { keep: "value" })).toEqual({
			to: "/agents/$id/$section",
			params: { id: "agent 1", section: "channel-links" },
			search: { keep: "value" },
		});
	});

	it("parses only canonical section segments", () => {
		expect(agentSectionSegment("projects")).toBe("project-access");
		expect(parseAgentSectionSegment("project-access")).toBe("projects");
		expect(parseAgentSectionSegment("vaults")).toBe("vaults");
		expect(parseAgentSectionSegment("connectors")).toBe("connectors");
		expect(parseAgentSectionSegment("model-provider")).toBe("ai");
		expect(parseAgentSectionSegment("channel-links")).toBe("channels");
		expect(parseAgentSectionSegment("files")).toBe("files");
		expect(parseAgentSectionSegment("settings")).toBe("settings");
		expect(parseAgentSectionSegment("projects")).toBeNull();
		expect(parseAgentSectionSegment("ai")).toBeNull();
		expect(parseAgentSectionSegment("channels")).toBeNull();
		expect(parseAgentSectionSegment("compute")).toBeNull();
		expect(parseAgentSectionSegment("bad")).toBeNull();
	});

	it("keeps every released agent section segment backward-compatible", () => {
		const sections = [
			"overview",
			"sessions",
			"memories",
			"skills",
			"projects",
			"vaults",
			"console",
			"files",
			"terminal",
			"connectors",
			"ai",
			"channels",
			"settings",
		] as const;
		expect(
			Object.fromEntries(sections.map((section) => [section, agentSectionSegment(section)])),
		).toEqual({
			overview: "",
			sessions: "sessions",
			memories: "memories",
			skills: "skills",
			projects: "project-access",
			vaults: "vaults",
			console: "console",
			files: "files",
			terminal: "terminal",
			connectors: "connectors",
			ai: "model-provider",
			channels: "channel-links",
			settings: "settings",
		});
	});

	it("keeps canonical labels while preserving backward-compatible URL segments", () => {
		expect(agentSectionLabel("projects")).toBe("Projects");
		expect(agentSectionLabel("memories")).toBe("Memories");
		expect(agentSectionLabel("console")).toBe("Agent Interface");
		expect(agentSectionLabel("files")).toBe("Files");
		expect(agentSectionLabel("channels")).toBe("Channels");
		expect(agentSectionLabel("connectors")).toBe("Connectors");
		expect(agentSectionLabel("vaults")).toBe("Vaults");
		expect(agentSectionLabelFromSegment("project-access")).toBe("Projects");
		expect(agentSectionLabelFromSegment("memories")).toBe("Memories");
		expect(agentSectionLabelFromSegment("console")).toBe("Agent Interface");
		expect(agentSectionLabelFromSegment("files")).toBe("Files");
		expect(agentSectionLabelFromSegment("model-provider")).toBe("AI Providers");
		expect(agentSectionLabelFromSegment("connectors")).toBe("Connectors");
		expect(agentSectionLabelFromSegment("vaults")).toBe("Vaults");
		expect(agentSectionLabelFromSegment("settings")).toBe("Settings");
		expect(agentSectionLabelFromSegment("bad")).toBeNull();
	});

	it("keeps released account-resource deep links available for connected and hosted detail", () => {
		for (const section of ["memories", "projects", "connectors"] as const) {
			expect(CONNECTED_AGENT_SECTION_IDS).toContain(section);
			expect(HOSTED_AGENT_SECTION_IDS).toContain(section);
		}
		for (const section of ["skills", "vaults"] as const) {
			expect(CONNECTED_AGENT_SECTION_IDS).not.toContain(section);
			expect(HOSTED_AGENT_SECTION_IDS).not.toContain(section);
			expect(parseAgentSectionSegment(section)).toBe(section);
		}
		expect(CONNECTED_AGENT_SECTION_IDS).not.toContain("mcp");
		expect(HOSTED_AGENT_SECTION_IDS).not.toContain("mcp");
	});

	it("detects and removes tab params without changing the canonical section", () => {
		expect(agentRouteQueryString({ tab: "settings", settings: "billing-plan" })).toBe(
			"settings=billing-plan",
		);
		expect(agentSectionHref("agent 1", "overview", { tab: "sessions" })).toBe("/agents/agent%201");
		expect(agentSectionHref("agent 1", "projects", { tab: "settings" })).toBe(
			"/agents/agent%201/project-access",
		);
	});

	it("canonicalizes legacy tab bookmarks through one explicit mapping", () => {
		expect(legacyAgentRoute("overview", { tab: "sessions", filter: "active" })).toEqual({
			section: "sessions",
			search: { filter: "active" },
		});
		expect(legacyAgentRoute("overview", { tab: "memories" })).toEqual({
			section: "memories",
			search: undefined,
		});
		expect(legacyAgentRoute("skills", { tab: "channel-links" })).toEqual({
			section: "channels",
			search: undefined,
		});
		expect(legacyAgentRoute("overview", { tab: "connectors" })).toEqual({
			section: "connectors",
			search: undefined,
		});
		expect(legacyAgentRoute("overview", { tab: "vaults" })).toEqual({
			section: "vaults",
			search: undefined,
		});
		expect(legacyAgentRoute("skills", { filter: "active" })).toBeNull();
	});

	it("parses agent pathnames for sidebar state", () => {
		expect(parseAgentPathname("/")).toBeNull();
		expect(parseAgentPathname("/agents/agent%201")).toEqual({
			agentId: "agent 1",
			section: "overview",
			sessionId: undefined,
			skillKey: undefined,
		});
		expect(parseAgentPathname("/agents/agent%201/project-access")).toEqual({
			agentId: "agent 1",
			section: "projects",
			sessionId: undefined,
			skillKey: undefined,
		});
		expect(parseAgentPathname("/agents/agent%201/memories")).toEqual({
			agentId: "agent 1",
			section: "memories",
			sessionId: undefined,
			skillKey: undefined,
		});
		expect(parseAgentPathname("/agents/agent%201/connectors")).toEqual({
			agentId: "agent 1",
			section: "connectors",
			sessionId: undefined,
			skillKey: undefined,
		});
		expect(parseAgentPathname("/agents/agent%201/memories/memory%201")).toEqual({
			agentId: "agent 1",
			section: "memories",
			sessionId: undefined,
			skillKey: undefined,
			memoryId: "memory 1",
		});
		expect(parseAgentPathname("/agents/agent%201/connectors/google%20drive")).toEqual({
			agentId: "agent 1",
			section: "connectors",
			sessionId: undefined,
			skillKey: undefined,
			connectorName: "google drive",
		});
		expect(parseAgentPathname("/agents/agent%201/vaults")).toEqual({
			agentId: "agent 1",
			section: "vaults",
			sessionId: undefined,
			skillKey: undefined,
		});
		expect(parseAgentPathname("/agents/agent%201/project-access/project%201")).toEqual({
			agentId: "agent 1",
			section: "projects",
			sessionId: undefined,
			skillKey: undefined,
			projectId: "project 1",
		});
		expect(parseAgentPathname("/agents/agent%201/project-access/project%201/skills")).toEqual({
			agentId: "agent 1",
			section: "projects",
			sessionId: undefined,
			skillKey: undefined,
			projectId: "project 1",
			projectResource: "skills",
		});
		expect(parseAgentPathname("/agents/agent%201/project-access/project%201/vaults")).toEqual({
			agentId: "agent 1",
			section: "projects",
			sessionId: undefined,
			skillKey: undefined,
			projectId: "project 1",
			projectResource: "vaults",
		});
		expect(parseAgentPathname("/agents/agent%201/vaults/prod%20keys")).toEqual({
			agentId: "agent 1",
			section: "vaults",
			sessionId: undefined,
			skillKey: undefined,
			vaultSlug: "prod keys",
		});
		expect(parseAgentPathname("/agents/agent%201/sessions/session%201")).toEqual({
			agentId: "agent 1",
			section: "sessions",
			sessionId: "session 1",
			skillKey: undefined,
		});
		expect(parseAgentPathname("/agents/agent%201/skills/team%2Ffoo")).toEqual({
			agentId: "agent 1",
			section: "skills",
			sessionId: undefined,
			skillKey: "team/foo",
		});
		expect(parseAgentPathname("/agents/agent%201/skills/team/foo")).toEqual({
			agentId: "agent 1",
			section: "skills",
			sessionId: undefined,
			skillKey: "team/foo",
		});
		expect(parseAgentPathname("/agents/agent%201/projects")).toBeNull();
		expect(parseAgentPathname("/agents/agent%201/project-access/project/extra")).toBeNull();
		expect(parseAgentPathname("/agents/agent%201/project-access/project/skills/extra")).toBeNull();
		expect(parseAgentPathname("/agents/agent%201/vaults/prod/extra")).toBeNull();
		expect(parseAgentPathname("/agents/agent%201/memories/memory/extra")).toBeNull();
		expect(parseAgentPathname("/agents/agent%201/connectors/github/extra")).toBeNull();
		expect(parseAgentPathname("/agents/agent%201/compute")).toBeNull();
		expect(parseAgentPathname("/AGENTS/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/SKILLS")).toEqual({
			agentId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
			section: "skills",
			sessionId: undefined,
			skillKey: undefined,
		});
	});
});
