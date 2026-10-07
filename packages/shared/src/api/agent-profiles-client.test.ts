import { expect, test } from "bun:test";
import { createAgentProfilesClient } from "./agent-profiles-client";
import { ApiClientError } from "./read-transport";
import type { AgentProfile } from "./schemas";

test("lists profiles with authentication and an escaped Agent id, preserving API order", async () => {
	const profiles: AgentProfile[] = [
		{
			id: "removed-profile",
			profile_key: "old",
			is_default: false,
			state: "removed",
			session_count: 2,
		},
		{
			id: "default-profile",
			profile_key: "",
			is_default: true,
			state: "active",
			session_count: 5,
		},
	];
	let calls = 0;
	const client = createAgentProfilesClient({
		baseUrl: "https://api.example.test/",
		getToken: async () => "test-token",
		fetch: async (request) => {
			calls += 1;
			expect(request.method).toBe("GET");
			expect(new URL(request.url).pathname).toBe("/v1/agents/agent%2Fa%3Fb/profiles");
			expect(request.headers.get("Authorization")).toBe("Bearer test-token");
			return Response.json(profiles);
		},
	});
	expect(await client.listProfiles("agent/a?b")).toEqual(profiles);
	expect(calls).toBe(1);
});

test("rejects invalid Agent ids and cancelled reads before sending a request", async () => {
	let calls = 0;
	const client = createAgentProfilesClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "test-token",
		fetch: async () => {
			calls += 1;
			return Response.json([]);
		},
	});
	await expect(client.listProfiles(" ")).rejects.toMatchObject({
		status: 400,
		code: "invalid_resource_id",
	});
	const controller = new AbortController();
	controller.abort();
	await expect(client.listProfiles("agent", controller.signal)).rejects.toMatchObject({
		name: "AbortError",
	});
	expect(calls).toBe(0);
});

test("surfaces API errors through the shared transport without exposing the response detail", async () => {
	const client = createAgentProfilesClient({
		baseUrl: "https://api.example.test",
		getToken: async () => "test-token",
		fetch: async () =>
			Response.json(
				{ detail: { code: "agent_not_found", message: "Internal lookup failed" } },
				{ status: 404 },
			),
	});
	await expect(client.listProfiles("agent")).rejects.toEqual(
		new ApiClientError(404, "agent_not_found"),
	);
});
