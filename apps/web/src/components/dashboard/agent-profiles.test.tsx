import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "@clawdi/shared/api";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentProfilesOverview } from "@/components/dashboard/agent-profiles";

function render(children: ReactNode) {
	const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
	return renderToStaticMarkup(
		<RouterContextProvider router={router}>{children}</RouterContextProvider>,
	);
}

const DEFAULT_PROFILE: AgentProfile = {
	id: "00000000-0000-4000-8000-000000000001",
	profile_key: "",
	is_default: true,
	state: "active",
	session_count: 147,
};

describe("AgentProfilesOverview", () => {
	test("adds nothing for a single-profile Agent", () => {
		const markup = render(
			<AgentProfilesOverview
				agentId="agent-1"
				agentName="Hermes"
				agentType="hermes"
				profiles={[DEFAULT_PROFILE]}
				linkSessions
			/>,
		);
		expect(markup).toBe("");
	});

	test("lists every profile with state and a filtered sessions link", () => {
		const markup = render(
			<AgentProfilesOverview
				agentId="agent-1"
				agentName="Hermes"
				agentType="hermes"
				profiles={[
					DEFAULT_PROFILE,
					{
						...DEFAULT_PROFILE,
						id: "00000000-0000-4000-8000-000000000002",
						profile_key: "work",
						is_default: false,
						session_count: 1,
					},
					{
						...DEFAULT_PROFILE,
						id: "00000000-0000-4000-8000-000000000003",
						profile_key: "old",
						is_default: false,
						state: "removed",
					},
				]}
				linkSessions
			/>,
		);
		expect(markup.match(/data-testid="agent-profile-row"/g)).toHaveLength(3);
		expect(markup).toContain(">Hermes<");
		expect(markup).toContain("Hermes · work");
		expect(markup).toContain("1 session<");
		expect(markup).toContain("View sessions for Hermes · old, removed");
		expect(markup).toContain("View sessions for Hermes · work<");
		// Only the removed profile carries a badge; profiles have no liveness of their own.
		expect(markup.match(/data-slot="status-badge"/g)).toHaveLength(1);
		expect(markup).toContain(">Removed<");
		expect(markup).not.toMatch(/Online|Offline|Last seen/);
		expect(markup).toContain(
			"/agents/agent-1/sessions?profile=00000000-0000-4000-8000-000000000002",
		);
	});
});
