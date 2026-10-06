import { expect, test } from "bun:test";
import { createProviderRemovalClient, providerRemovalHeaders } from "./provider-removal-client";
import { ApiClientResponseError } from "./read-transport";

test("a response for another provider cannot be reviewed or reported as successful removal", async () => {
	const impact = {
		provider_id: "requested",
		impact_revision: "a".repeat(64),
		provider_incarnation_token: "b".repeat(64),
		agents: [],
	};
	const client = createProviderRemovalClient({
		baseUrl: "https://hosted.example",
		getToken: async () => "fixture",
		fetch: async () =>
			Response.json({
				...impact,
				provider_id: "different",
				status: "removed",
				remote_revoke_status: "not_required",
			}),
	});
	await expect(client.impact("requested")).rejects.toBeInstanceOf(ApiClientResponseError);
	await expect(client.remove(impact, "attempt")).rejects.toBeInstanceOf(ApiClientResponseError);
});

test("removal validates exact server confirmation formats before token acquisition", async () => {
	let tokens = 0;
	const client = createProviderRemovalClient({
		baseUrl: "https://hosted.example",
		getToken: async () => {
			tokens++;
			return "fixture";
		},
		fetch: async () => {
			throw new Error("Unexpected network");
		},
	});
	const impact = {
		provider_id: "work",
		impact_revision: "a".repeat(64),
		provider_incarnation_token: "b".repeat(64),
		agents: [],
	};
	for (const bad of ["", "a".repeat(63), "A".repeat(64), "b\n"]) {
		await expect(client.remove({ ...impact, impact_revision: bad }, "key")).rejects.toMatchObject({
			status: 400,
		});
		await expect(
			client.remove({ ...impact, provider_incarnation_token: bad }, "key"),
		).rejects.toMatchObject({ status: 400 });
	}
	for (const key of ["", "bad key", "x".repeat(256)])
		await expect(client.remove(impact, key)).rejects.toMatchObject({ status: 400 });
	expect(tokens).toBe(0);
	expect(
		providerRemovalHeaders(
			impact.impact_revision,
			impact.provider_incarnation_token,
			"x".repeat(255),
		)["Idempotency-Key"],
	).toHaveLength(255);
});

test("uncertain removal never auto-retries and explicit recovery preserves impact, incarnation and idempotency key", async () => {
	const impact = {
		provider_id: "work/a?b",
		impact_revision: "a".repeat(64),
		provider_incarnation_token: "b".repeat(64),
		agents: [{ deployment_id: "agent-one", name: "Work" }],
	};
	const confirmations: unknown[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			const path = new URL(request.url).pathname;
			if (request.method === "GET") {
				expect(path).toBe("/v2/ai-providers/work%2Fa%3Fb/removal-impact");
				return Response.json(impact);
			}
			expect(request.method).toBe("DELETE");
			expect(path).toBe("/v2/ai-providers/work%2Fa%3Fb");
			confirmations.push({
				revision: request.headers.get("impact-revision"),
				incarnation: request.headers.get("provider-incarnation"),
				key: request.headers.get("idempotency-key"),
			});
			if (confirmations.length === 1) return Response.json({ detail: "pending" }, { status: 503 });
			return Response.json({
				status: "removed",
				provider_id: impact.provider_id,
				affected_agents: impact.agents,
				cloud_archive_status: "archived",
				remote_revoke_status: "pending",
			});
		},
	});
	try {
		const client = createProviderRemovalClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		const reviewed = await client.impact(impact.provider_id);
		await expect(client.remove(reviewed, "attempt-one")).rejects.toMatchObject({ status: 503 });
		expect(confirmations).toHaveLength(1);
		expect((await client.remove(reviewed, "attempt-one")).remote_revoke_status).toBe("pending");
		expect(confirmations).toEqual(
			Array(2).fill({
				revision: impact.impact_revision,
				incarnation: impact.provider_incarnation_token,
				key: "attempt-one",
			}),
		);
	} finally {
		server.stop(true);
	}
});
