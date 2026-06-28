import { describe, expect, it } from "bun:test";
import {
	agentRouteQueryString,
	agentSectionHref,
	agentSectionLabel,
	agentSectionLabelFromSegment,
	agentSectionSegment,
	agentSessionDetailHref,
	agentSkillDetailHref,
	hasAgentTabQuery,
	parseAgentPathname,
	parseAgentSectionSegment,
} from "./agent-routes";

describe("agent routes", () => {
	it("builds canonical segment routes for agent sections", () => {
		expect(agentSectionHref("agent 1")).toBe("/agents/agent%201");
		expect(agentSectionHref("agent 1", "sessions")).toBe("/agents/agent%201/sessions");
		expect(agentSectionHref("agent 1", "projects")).toBe("/agents/agent%201/project-access");
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
		).toBe("/agents/agent%201/sessions?tag=a&tag=b");
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
		expect(agentSectionLabelFromSegment("project-access")).toBe("Project Access");
		expect(agentSectionLabelFromSegment("model-provider")).toBe("Model Provider");
		expect(agentSectionLabelFromSegment("settings")).toBe("Settings");
		expect(agentSectionLabelFromSegment("bad")).toBeNull();
	});

	it("detects and removes tab params without changing the canonical section", () => {
		expect(hasAgentTabQuery({ tab: "settings" })).toBe(true);
		expect(hasAgentTabQuery({ settings: "billing-plan" })).toBe(false);
		expect(agentRouteQueryString({ tab: "settings", settings: "billing-plan" })).toBe(
			"settings=billing-plan",
		);
		expect(agentSectionHref("agent 1", "overview", { tab: "sessions" })).toBe("/agents/agent%201");
		expect(agentSectionHref("agent 1", "projects", { tab: "settings" })).toBe(
			"/agents/agent%201/project-access",
		);
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
	});
});
