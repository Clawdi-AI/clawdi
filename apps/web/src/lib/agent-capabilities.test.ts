import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentOverviewCapabilities } from "@/components/dashboard/agent-overview-capabilities";
import { agentOverviewGroups } from "@/lib/agent-capabilities";
import { AGENT_SECTION_NAVIGATION_ITEMS } from "@/lib/navigation-model";

describe("agent overview registry", () => {
	test("only registers supported sections with real summaries", () => {
		for (const variant of ["connected", "hosted"] as const) {
			for (const module of agentOverviewGroups(variant).flatMap((group) => group.modules))
				expect(AGENT_SECTION_NAVIGATION_ITEMS[module.section].variants).toContain(variant);
		}
	});
	test("skips a missing summary without rendering an empty card or crashing the overview", () => {
		const markup = renderToStaticMarkup(
			createElement(AgentOverviewCapabilities, { agentId: "", variant: "connected", content: {} }),
		);
		expect(markup).not.toContain("data-overview-module=");
	});
});
