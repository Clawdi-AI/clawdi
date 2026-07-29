import { describe, expect, it } from "bun:test";
import {
	agentDeploymentRouteQuery,
	agentDeploymentSelector,
	agentRouteOwnsSection,
	agentRouteQueryString,
	agentSectionHref,
	agentSectionLabel,
	agentSectionLabelFromSegment,
	agentSectionLink,
	agentSectionSegment,
	agentSessionDetailHref,
	agentSessionDetailLink,
	agentSkillDetailHref,
	agentSkillDetailLink,
	bindAgentDeploymentSearch,
	CONNECTED_AGENT_SECTION_IDS,
	HOSTED_AGENT_SECTION_IDS,
	legacyAgentRoute,
	parseAgentPathname,
	parseAgentSectionSegment,
} from "./agent-routes";

describe("agent routes", () => {
	it("builds canonical segment routes for agent sections", () => {
		expect(agentSectionHref("agent 1")).toBe("/agents/agent%201");
		expect(agentSectionHref("agent 1", "sessions")).toBe("/agents/agent%201/sessions");
		expect(agentSectionHref("agent 1", "projects")).toBe("/agents/agent%201/project-access");
		expect(agentSectionHref("agent 1", "mcp")).toBe("/agents/agent%201/mcp");
		expect(agentSectionHref("agent 1", "ai")).toBe("/agents/agent%201/model-provider");
		expect(agentSectionHref("agent 1", "channels")).toBe("/agents/agent%201/channel-links");
		expect(agentSectionHref("agent 1", "settings")).toBe("/agents/agent%201/settings");
		expect(agentSessionDetailHref("agent 1", "session 1")).toBe(
			"/agents/agent%201/sessions/session%201",
		);
		expect(agentSkillDetailHref("agent 1", "team/foo", "proj 1")).toBe(
			"/agents/agent%201/skills/team/foo?project=proj%201",
		);
		expect(agentSkillDetailHref("agent 1", "team/foo")).toBe("/agents/agent%201/skills/team/foo");
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

	it("preserves only deployment identity while navigating agent sections", () => {
		const query = "source=on-clawdi&d=dep_older&checkout=success";

		expect(agentDeploymentSelector(query)).toBe("dep_older");
		expect(agentDeploymentRouteQuery(query)).toEqual({
			source: "on-clawdi",
			d: "dep_older",
		});
		expect(agentSectionHref("agent 1", "settings", agentDeploymentRouteQuery(query))).toBe(
			"/agents/agent%201/settings?source=on-clawdi&d=dep_older",
		);
	});

	it("preserves deployment identity on session and skill detail links", () => {
		const query = "source=on-clawdi&d=hdep_selected";

		expect(agentSessionDetailHref("agent 1", "session 1", query)).toBe(
			"/agents/agent%201/sessions/session%201?source=on-clawdi&d=hdep_selected",
		);
		expect(agentSkillDetailHref("agent 1", "team/foo", "proj 1", query)).toBe(
			"/agents/agent%201/skills/team/foo?source=on-clawdi&d=hdep_selected&project=proj%201",
		);
		expect(agentSessionDetailLink("agent 1", "session 1", query)).toEqual({
			to: "/agents/$id/sessions/$sessionId",
			params: { id: "agent 1", sessionId: "session 1" },
			search: { source: "on-clawdi", d: "hdep_selected" },
		});
		expect(agentSkillDetailLink("agent 1", "team/foo", "proj 1", query)).toEqual({
			to: "/agents/$id/skills/$",
			params: { id: "agent 1", _splat: "team/foo" },
			search: { source: "on-clawdi", d: "hdep_selected", project: "proj 1" },
		});
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
		expect(agentRouteOwnsSection("/agents/agent-1/skills", "agent-1", "overview")).toBe(false);
	});

	it("augments the current location when binding a deployment", () => {
		expect(
			bindAgentDeploymentSearch(
				{ project: "proj-1", source: "on-clawdi", d: "hdep_stale" },
				"hdep_current",
			),
		).toEqual({ project: "proj-1", source: "on-clawdi", d: "hdep_current" });
	});

	it("owns canonical section navigation with typed Router options", () => {
		expect(agentSectionLink("agent 1", "overview", { d: "hdep_1" })).toEqual({
			to: "/agents/$id",
			params: { id: "agent 1" },
			search: { d: "hdep_1" },
		});
		expect(agentSectionLink("agent 1", "skills", { d: "hdep_1" })).toEqual({
			to: "/agents/$id/skills",
			params: { id: "agent 1" },
			search: { d: "hdep_1" },
		});
		expect(agentSectionLink("agent 1", "channels", { d: "hdep_1" })).toEqual({
			to: "/agents/$id/$section",
			params: { id: "agent 1", section: "channel-links" },
			search: { d: "hdep_1" },
		});
	});

	it("parses only canonical section segments", () => {
		expect(agentSectionSegment("projects")).toBe("project-access");
		expect(parseAgentSectionSegment("project-access")).toBe("projects");
		expect(parseAgentSectionSegment("model-provider")).toBe("ai");
		expect(parseAgentSectionSegment("channel-links")).toBe("channels");
		expect(parseAgentSectionSegment("settings")).toBe("settings");
		expect(parseAgentSectionSegment("projects")).toBeNull();
		expect(parseAgentSectionSegment("ai")).toBeNull();
		expect(parseAgentSectionSegment("channels")).toBeNull();
		expect(parseAgentSectionSegment("compute")).toBeNull();
		expect(parseAgentSectionSegment("bad")).toBeNull();
	});

	it("keeps labels and URL segments in one route table", () => {
		expect(agentSectionLabel("projects")).toBe("Project Access");
		expect(agentSectionLabel("console")).toBe("Agent Interface");
		expect(agentSectionLabelFromSegment("project-access")).toBe("Project Access");
		expect(agentSectionLabelFromSegment("console")).toBe("Agent Interface");
		expect(agentSectionLabelFromSegment("model-provider")).toBe("Model Provider");
		expect(agentSectionLabelFromSegment("settings")).toBe("Settings");
		expect(agentSectionLabelFromSegment("bad")).toBeNull();
	});

	it("keeps Skills available for connected and hosted agent detail", () => {
		expect(CONNECTED_AGENT_SECTION_IDS).toContain("skills");
		expect(HOSTED_AGENT_SECTION_IDS).toContain("skills");
		expect(CONNECTED_AGENT_SECTION_IDS).not.toContain("mcp");
		expect(HOSTED_AGENT_SECTION_IDS).toContain("mcp");
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
		expect(legacyAgentRoute("skills", { tab: "channel-links" })).toEqual({
			section: "channels",
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
		expect(parseAgentPathname("/agents/agent%201/mcp")).toEqual({
			agentId: "agent 1",
			section: "mcp",
			sessionId: undefined,
			skillKey: undefined,
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
		expect(parseAgentPathname("/agents/agent%201/compute")).toBeNull();
		expect(parseAgentPathname("/AGENTS/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/SKILLS")).toEqual({
			agentId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
			section: "skills",
			sessionId: undefined,
			skillKey: undefined,
		});
	});
});
