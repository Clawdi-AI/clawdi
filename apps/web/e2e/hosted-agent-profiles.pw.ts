import type { AgentProfile } from "@clawdi/shared/api";
import { expect, type Page, test } from "@playwright/test";
import {
	CLOUD_API,
	fulfillJson,
	includedBasicDeployment,
	sharedLegacyCloudAgent,
	stubHostedApi,
} from "./support/hosted-api-stub";

const now = "2026-10-06T12:00:00.000Z";
const MULTI_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SINGLE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function hostedAgent(id: string, name: string, deploymentId: string) {
	return {
		deployment: {
			...includedBasicDeployment,
			id: deploymentId,
			agent_id: id,
			name,
			config_info: {
				...includedBasicDeployment.config_info,
				clawdi_cloud_environments: { hermes: id },
			},
		},
		cloudAgent: {
			...sharedLegacyCloudAgent,
			id,
			name,
			default_name: name,
			machine_name: `${name}.local`,
			display_name: name,
			last_seen_at: now,
			last_sync_at: now,
		},
	};
}

const multi = hostedAgent(MULTI_ID, "Ops Hermes", "hdep_profiles_multi");
const single = hostedAgent(SINGLE_ID, "Solo Hermes", "hdep_profiles_single");

function profile(
	agentId: string,
	key: string,
	overrides: Partial<AgentProfile> = {},
): AgentProfile {
	return {
		id: `${agentId.slice(0, 8)}-0000-4000-8000-${(key || "default").padEnd(12, "0").slice(0, 12)}`,
		profile_key: key,
		is_default: key === "",
		state: "active",
		session_count: 0,
		...overrides,
	};
}

// The default profile has more than one page of sessions so the sessions tab
// can prove that changing the profile returns to page 1.
const sessionCounts: Record<string, Record<string, number>> = {
	[MULTI_ID]: { "": 25, work: 3, research: 1 },
	[SINGLE_ID]: { "": 2 },
};

const profilesByAgent: Record<string, AgentProfile[]> = {
	[MULTI_ID]: [
		profile(MULTI_ID, "", { session_count: 25 }),
		profile(MULTI_ID, "research", {
			state: "removed",
			session_count: 1,
		}),
		profile(MULTI_ID, "staging"),
		profile(MULTI_ID, "work", { session_count: 3 }),
	],
	[SINGLE_ID]: [profile(SINGLE_ID, "", { session_count: 2 })],
};

function sessions(agentId: string, profileKey: string, count: number) {
	const agent = agentId === MULTI_ID ? multi.cloudAgent : single.cloudAgent;
	return Array.from({ length: count }, (_, index) => ({
		id: `${agentId.slice(0, 8)}-${profileKey || "default"}-${index + 1}`,
		local_session_id: `local-${profileKey || "default"}-${index + 1}`,
		project_path: null,
		agent_name: agent.name,
		agent_display_name: agent.display_name,
		agent_default_name: agent.default_name,
		agent_type: "hermes",
		machine_name: agent.machine_name,
		environment_id: agentId,
		profile_key: profileKey,
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
		summary: `${profileKey || "Default"} session ${index + 1}`,
		tags: [],
		status: "completed",
		content_protocol: "snapshot-v1",
		is_shared: false,
	}));
}

type SessionRequest = {
	environment_id: string | null;
	profile_key: string | null;
	page: string | null;
	page_size: string | null;
};

async function stubProfiles(page: Page) {
	await stubHostedApi(page, {
		deployments: [multi.deployment, single.deployment],
		cloudAgents: [multi.cloudAgent, single.cloudAgent],
	});
	const requests: SessionRequest[] = [];
	// Registered after the shared stub so these handlers take precedence.
	await page.route(`${CLOUD_API}/v1/agents/*`, (route) => {
		const id = new URL(route.request().url()).pathname.split("/")[3];
		const agent = [multi.cloudAgent, single.cloudAgent].find((item) => item.id === id);
		return agent ? fulfillJson(route, agent) : route.fallback();
	});
	await page.route(`${CLOUD_API}/v1/agents/*/profiles`, (route) => {
		const id = new URL(route.request().url()).pathname.split("/")[3] ?? "";
		return fulfillJson(route, profilesByAgent[id] ?? []);
	});
	await page.route(
		(url) => url.origin === CLOUD_API && url.pathname === "/v1/sessions",
		(route) => {
			const params = new URL(route.request().url()).searchParams;
			const request: SessionRequest = {
				environment_id: params.get("environment_id"),
				profile_key: params.get("profile_key"),
				page: params.get("page"),
				page_size: params.get("page_size"),
			};
			requests.push(request);
			const counts = sessionCounts[request.environment_id ?? ""] ?? {};
			const items = Object.entries(counts)
				.filter(([key]) => request.profile_key === null || key === request.profile_key)
				.flatMap(([key, count]) => sessions(request.environment_id ?? "", key, count));
			const pageNumber = Number(request.page ?? "1");
			const pageSize = Number(request.page_size ?? "50");
			const start = (pageNumber - 1) * pageSize;
			return fulfillJson(route, {
				items: items.slice(start, start + pageSize),
				total: items.length,
				page: pageNumber,
				page_size: pageSize,
			});
		},
	);
	return requests;
}

test("Hosted overview lists every profile with its session count", async ({ page }) => {
	await stubProfiles(page);

	await page.goto(`/agents/${MULTI_ID}`);
	await expect(page.getByRole("heading", { name: "Profiles" })).toBeVisible();
	const rows = page.getByTestId("agent-profile-row");
	await expect(rows).toHaveCount(4);
	await expect(rows.nth(0)).toContainText("Ops Hermes");
	await expect(rows.nth(0)).toContainText("25 sessions");
	await expect(rows.nth(1)).toContainText("Ops Hermes · staging");
	await expect(rows.nth(1)).toContainText("0 sessions");
	await expect(rows.nth(2)).toContainText("Ops Hermes · work");
	await expect(rows.nth(2)).toContainText("3 sessions");
	await expect(rows.nth(3)).toContainText("Ops Hermes · research");
	await expect(rows.nth(3)).toContainText("Removed");
	await expect(page.getByTestId("agent-profile-list")).not.toContainText(
		/Online|Offline|Last seen/,
	);

	await page
		.getByRole("link", { name: "View sessions for Ops Hermes · work", exact: true })
		.click();
	await expect(page).toHaveURL(new RegExp(`/agents/${MULTI_ID}/sessions\\?profile=`));
	await expect(page.getByTestId("session-card")).toHaveCount(3);
});

test("Hosted sessions filter by profile and reset to the first page", async ({ page }) => {
	const requests = await stubProfiles(page);

	await page.goto(`/agents/${MULTI_ID}/sessions`);
	await expect(page.getByTestId("session-card")).toHaveCount(20);
	await page.getByRole("button", { name: "Next page" }).click();
	await expect(page.getByTestId("session-card")).toHaveCount(9);
	expect(requests.at(-1)).toMatchObject({ profile_key: null, page: "2" });

	await page.getByRole("button", { name: /Profile/ }).click();
	await expect(page.getByRole("option", { name: "research (removed)", exact: true })).toBeVisible();
	await page.getByRole("option", { name: "work", exact: true }).click();
	await expect(page).toHaveURL(/\?profile=/);
	await expect(page.getByTestId("session-card")).toHaveCount(3);
	expect(requests.at(-1)).toMatchObject({
		environment_id: MULTI_ID,
		profile_key: "work",
		page: "1",
	});
	// The page reset lands with the profile change, so the old page is never requested.
	expect(requests.filter((request) => request.profile_key === "work")).toEqual([
		expect.objectContaining({ page: "1" }),
	]);
});

test("Hosted sessions drop an unknown profile id from the URL", async ({ page }) => {
	const requests = await stubProfiles(page);

	await page.goto(`/agents/${MULTI_ID}/sessions?profile=00000000-0000-4000-8000-000000000000`);
	await expect(page).not.toHaveURL(/profile=/);
	await expect(page.getByTestId("session-card")).toHaveCount(20);
	expect(requests.every((request) => request.profile_key === null)).toBe(true);
});

test("single-profile Hosted Agents keep today's overview and sessions", async ({ page }) => {
	const requests = await stubProfiles(page);

	await page.goto(`/agents/${SINGLE_ID}`);
	await expect(page.getByRole("heading", { name: "Recent sessions" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Profiles" })).toHaveCount(0);

	await page.goto(`/agents/${SINGLE_ID}/sessions`);
	await expect(page.getByTestId("session-card")).toHaveCount(2);
	await expect(page.getByRole("button", { name: /Profile/ })).toHaveCount(0);
	expect(requests.every((request) => request.profile_key === null)).toBe(true);
});
