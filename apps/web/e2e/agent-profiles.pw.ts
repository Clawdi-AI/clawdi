import { expect, type Page, type Route, test } from "@playwright/test";

const now = "2026-10-06T12:00:00.000Z";
const SINGLE_ID = "11111111-1111-4111-8111-111111111111";
const MULTI_ID = "22222222-2222-4222-8222-222222222222";

function agent(id: string, name: string, agentType: string) {
	return {
		id,
		name,
		default_name: name,
		machine_name: `${name}.local`,
		display_name: name,
		avatar_url: null,
		sort_order: 0,
		agent_type: agentType,
		agent_version: "1.0.0",
		os: "linux",
		adapter_modules: ["sessions", "skills"],
		last_seen_at: now,
		last_sync_at: now,
		last_sync_error: null,
		last_revision_seen: 1,
		queue_depth_high_water: 0,
		dropped_count: 0,
		sync_enabled: true,
		explicit_identity: true,
		default_project_id: null,
	};
}

const agents = [agent(SINGLE_ID, "Laptop Codex", "codex"), agent(MULTI_ID, "Ops Hermes", "hermes")];

function profile(agentId: string, key: string, overrides: Record<string, unknown> = {}) {
	return {
		id: `${agentId.slice(0, 8)}-0000-4000-8000-${(key || "default").padEnd(12, "0").slice(0, 12)}`,
		profile_key: key,
		upstream_key: key || "default",
		is_default: key === "",
		display_name: null,
		state: "active",
		online: true,
		first_seen_at: now,
		last_seen_at: now,
		removed_at: null,
		session_count: 1,
		...overrides,
	};
}

const profilesByAgent: Record<string, unknown[]> = {
	[SINGLE_ID]: [profile(SINGLE_ID, "")],
	[MULTI_ID]: [
		profile(MULTI_ID, ""),
		profile(MULTI_ID, "research", { state: "removed", online: false, removed_at: now }),
		profile(MULTI_ID, "work", { session_count: 2 }),
	],
};

function session(agentId: string, profileKey: string, summary: string) {
	const owner = agents.find((candidate) => candidate.id === agentId);
	return {
		profile_key: profileKey,
		profile_display_name: profileKey || null,
		id: `${agentId.slice(0, 8)}-${profileKey || "default"}-${summary.length}`,
		local_session_id: `local-${summary.length}`,
		project_path: null,
		agent_name: owner?.name,
		agent_display_name: owner?.display_name,
		agent_default_name: owner?.default_name,
		agent_type: owner?.agent_type,
		machine_name: owner?.machine_name,
		environment_id: agentId,
		started_at: now,
		ended_at: null,
		updated_at: now,
		last_activity_at: now,
		duration_seconds: 60,
		message_count: 2,
		input_tokens: 10,
		output_tokens: 20,
		cache_read_tokens: 0,
		model: null,
		models_used: null,
		summary,
		tags: [],
		status: "completed",
		content_protocol: "snapshot-v1",
		is_shared: false,
	};
}

const sessions = [
	session(SINGLE_ID, "", "Fix flaky login test"),
	session(MULTI_ID, "", "Daily standup notes"),
	session(MULTI_ID, "work", "Draft quarterly roadmap"),
	session(MULTI_ID, "work", "Review vendor contract"),
];

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

type SessionRequest = { environment_id: string | null; profile_key: string | null };

async function stubApi(page: Page, sessionRequests: SessionRequest[]) {
	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === "/v1/auth/me") {
			return fulfillJson(route, { id: "user-1", email: "dev@clawdi.local", name: "Dev User" });
		}
		if (path === "/v1/agents") return fulfillJson(route, agents);
		const profilesMatch = path.match(/^\/v1\/agents\/([^/]+)\/profiles$/);
		if (profilesMatch) return fulfillJson(route, profilesByAgent[profilesMatch[1]] ?? []);
		const agentMatch = path.match(/^\/v1\/agents\/([^/]+)$/);
		if (agentMatch) {
			const found = agents.find((candidate) => candidate.id === agentMatch[1]);
			return fulfillJson(route, found ?? { detail: "Agent not found" }, found ? 200 : 404);
		}
		if (/^\/v1\/agents\/[^/]+\/project-bindings$/.test(path)) return fulfillJson(route, []);
		if (path === "/v1/sessions") {
			const environmentId = url.searchParams.get("environment_id");
			const profileKey = url.searchParams.get("profile_key");
			sessionRequests.push({ environment_id: environmentId, profile_key: profileKey });
			const items = sessions.filter(
				(item) =>
					(environmentId === null || item.environment_id === environmentId) &&
					(profileKey === null || item.profile_key === profileKey),
			);
			return fulfillJson(route, { items, total: items.length, page: 1, page_size: 50 });
		}
		if (path === "/v1/projects" || path === "/v1/connectors") return fulfillJson(route, []);
		if (path === "/v1/memories" || path === "/v1/vault" || path === "/v1/skills") {
			return fulfillJson(route, { items: [], total: 0, page: 1, page_size: 25 });
		}
		return fulfillJson(route, {});
	});
}

test("single-profile Agents keep today's overview and sessions list", async ({ page }) => {
	const requests: SessionRequest[] = [];
	await stubApi(page, requests);

	await page.goto(`/agents/${SINGLE_ID}`);
	await expect(page.getByRole("heading", { name: "Recent sessions" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Profiles" })).toHaveCount(0);

	await page.goto(`/agents/${SINGLE_ID}/sessions`);
	await expect(page.getByTestId("session-card")).toHaveCount(1);
	await expect(page.getByRole("button", { name: "Profile" })).toHaveCount(0);
	expect(requests.every((request) => request.profile_key === null)).toBe(true);
});

test("multi-profile Agents list profiles and filter sessions by profile", async ({ page }) => {
	const requests: SessionRequest[] = [];
	await stubApi(page, requests);

	await page.goto(`/agents/${MULTI_ID}`);
	const rows = page.getByTestId("agent-profile-row");
	await expect(rows).toHaveCount(3);
	await expect(rows.nth(0)).toContainText("Ops Hermes");
	await expect(rows.nth(0)).toContainText("Online");
	await expect(rows.nth(1)).toContainText("Ops Hermes · work");
	await expect(rows.nth(1)).toContainText("2 sessions");
	await expect(rows.nth(2)).toContainText("Ops Hermes · research");
	await expect(rows.nth(2)).toContainText("Removed");
	await expect(rows.nth(2)).not.toContainText("Offline");

	await page.getByRole("link", { name: "View sessions for Ops Hermes · work, online" }).click();
	await expect(page).toHaveURL(/\/sessions\?profile=/);
	await expect(page.getByTestId("session-card")).toHaveCount(2);
	await expect(page.getByTestId("session-card").first()).toContainText("work");
	expect(requests.at(-1)).toEqual({ environment_id: MULTI_ID, profile_key: "work" });

	await page.getByRole("button", { name: /Profile/ }).click();
	await expect(page.getByRole("option", { name: "research (removed)", exact: true })).toBeVisible();
	await page.getByRole("option", { name: "Ops Hermes", exact: true }).click();
	await expect(page.getByTestId("session-card")).toHaveCount(1);
	await expect(page.getByTestId("session-card")).toContainText("Daily standup notes");
	await expect(page.getByTestId("session-card-meta")).not.toContainText("work");
	expect(requests.at(-1)).toEqual({ environment_id: MULTI_ID, profile_key: "" });
});

test("an unknown profile id is dropped from the URL", async ({ page }) => {
	const requests: SessionRequest[] = [];
	await stubApi(page, requests);

	await page.goto(`/agents/${MULTI_ID}/sessions?profile=00000000-0000-4000-8000-000000000000`);
	await expect(page).not.toHaveURL(/profile=/);
	await expect(page.getByTestId("session-card")).toHaveCount(3);
	expect(requests.every((request) => request.profile_key === null)).toBe(true);
});

test("the all-sessions list names non-default profiles as 'Agent · profile'", async ({ page }) => {
	await stubApi(page, []);

	await page.goto("/sessions");
	await expect(page.getByTestId("session-card")).toHaveCount(4);
	const work = page.getByTestId("session-card").filter({ hasText: "Review vendor contract" });
	await expect(work.getByTestId("session-card-meta")).toContainText("Ops Hermes · work");
	const standup = page.getByTestId("session-card").filter({ hasText: "Daily standup notes" });
	await expect(standup.getByTestId("session-card-meta")).toContainText("Ops Hermes");
	await expect(standup.getByTestId("session-card-meta")).not.toContainText("work");
});
