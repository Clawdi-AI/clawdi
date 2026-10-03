import { expect, test } from "bun:test";
import {
	createDeploymentMutationClient,
	type DeploymentMutation,
} from "./deployment-mutation-client";

test("invalid concurrency tokens fail before authentication or network", async () => {
	let tokens = 0;
	const client = createDeploymentMutationClient({
		baseUrl: "https://hosted.example",
		getToken: async () => {
			tokens++;
			return "fixture";
		},
		fetch: async () => {
			throw new Error("Unexpected request");
		},
	});
	for (const version of ["", "a b", 'a"b', "a\\b", "x".repeat(129)])
		await expect(client.apply("deployment", version, "key", { action: "stop" })).rejects.toThrow();
	for (const key of ["", "a b", "\n", "x".repeat(256)])
		await expect(
			client.apply("deployment", "version", key, { action: "stop" }),
		).rejects.toMatchObject({ status: 400 });
	expect(tokens).toBe(0);
});

test("all mutations preserve route, confirmation version and original intent on explicit retry", async () => {
	const requests: {
		path: string;
		method: string;
		version: string | null;
		key: string | null;
		body: unknown;
	}[] = [];
	let reject = true;
	let action = "start";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			requests.push({
				path: new URL(request.url).pathname,
				method: request.method,
				version: request.headers.get("if-match"),
				key: request.headers.get("idempotency-key"),
				body: request.method === "PATCH" ? await request.json() : null,
			});
			return reject
				? Response.json({ detail: "Unavailable" }, { status: 503 })
				: Response.json({
						name: "operations/op-1",
						done: false,
						metadata: { deploymentId: "deployment", verb: action },
					});
		},
	});
	try {
		const client = createDeploymentMutationClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		const mutations: DeploymentMutation[] = [
			{ action: "start" },
			{ action: "stop" },
			{ action: "restart" },
			{ action: "reset_runtime_ui_access" },
			{ action: "update", body: { language: "en", timezone: "America/Los_Angeles" } },
		];
		for (const mutation of mutations) {
			action = mutation.action;
			reject = true;
			const before = requests.length;
			await expect(client.apply("deployment", "v1", action, mutation)).rejects.toMatchObject({
				status: 503,
			});
			expect(requests.length).toBe(before + 1);
			reject = false;
			await client.apply("deployment", "v1", action, mutation);
			expect(requests[before]).toEqual(requests[before + 1]);
			expect(requests[before]).toEqual({
				path: `/v2/deployments/deployment${action === "update" ? "" : action === "reset_runtime_ui_access" ? "/runtime-ui/access/reset" : `/${action}`}`,
				method: action === "update" ? "PATCH" : "POST",
				version: '"v1"',
				key: action,
				body: mutation.action === "update" ? mutation.body : null,
			});
		}
	} finally {
		server.stop(true);
	}
});

test("foreign or malformed operation receipts cannot unlock confirmed intent", async () => {
	for (const receipt of [
		{ name: "operations/op", done: false, metadata: { deploymentId: "other", verb: "stop" } },
		{ name: "operations/op", done: false, metadata: { deploymentId: "deployment", verb: "start" } },
		{
			name: "https://other.example/op",
			done: false,
			metadata: { deploymentId: "deployment", verb: "stop" },
		},
		{ name: "operations/op", metadata: { deploymentId: "deployment", verb: "stop" } },
	]) {
		const client = createDeploymentMutationClient({
			baseUrl: "https://hosted.example",
			getToken: async () => "fixture",
			fetch: async () => Response.json(receipt),
		});
		await expect(client.apply("deployment", "v1", "key", { action: "stop" })).rejects.toThrow(
			"API response could not be read",
		);
	}
});
