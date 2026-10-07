import { describe, expect, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCard } from "@/components/sessions/session-feed";
import type { SessionListItem } from "@/lib/api-schemas";

const SESSION: SessionListItem = {
	profile_key: "",
	id: "session-1",
	local_session_id: "local-1",
	project_path: null,
	agent_display_name: "Hermes",
	agent_type: "hermes",
	started_at: "2026-10-06T00:00:00Z",
	ended_at: null,
	updated_at: "2026-10-06T00:00:00Z",
	last_activity_at: "2026-10-06T00:00:00Z",
	duration_seconds: null,
	message_count: 2,
	input_tokens: 10,
	output_tokens: 20,
	cache_read_tokens: 0,
	model: null,
	models_used: null,
	summary: "Plan the release",
	tags: null,
	status: "active",
	content_protocol: "snapshot-v1",
	is_shared: false,
};

function meta(session: SessionListItem, showAgent: boolean) {
	const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
	const markup = renderToStaticMarkup(
		<RouterContextProvider router={router}>
			<SessionCard session={session} showAgent={showAgent} link={{ to: "/" }} />
		</RouterContextProvider>,
	);
	const start = markup.indexOf('data-testid="session-card-meta"');
	return markup.slice(start).replace(/<[^>]+>/g, " ");
}

describe("SessionCard profile label", () => {
	test("default-profile sessions keep today's metadata", () => {
		expect(meta(SESSION, true)).not.toContain("Hermes ·");
		expect(meta(SESSION, false)).not.toContain("Hermes");
	});

	test("other profiles show 'Agent · profile', or the profile alone inside the Agent", () => {
		const work = { ...SESSION, profile_key: "work" };
		expect(meta(work, true)).toContain("Hermes · work");
		expect(meta(work, false)).toContain("work");
		expect(meta(work, false)).not.toContain("Hermes");
	});
});
