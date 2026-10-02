import { describe, expect, test } from "bun:test";
import type { components } from "./api.generated";
import type { DeployComponents, DeployRequestRead } from "./deploy";
import { createCloudApiClient, createHostedApiClient } from "./read-clients";
import {
	ApiClientError,
	ApiClientNetworkError,
	type ApiClientOptions,
	ApiClientResponseError,
} from "./read-transport";

const options: ApiClientOptions = {
	baseUrl: "https://cloud.example.test",
	getToken: async () => "owner-token",
	fetch: async () => Response.json([]),
};

type ObservedRequest = { url: string; method: string; authorization: string | null };

const agent: components["schemas"]["AgentResponse"] = {
	id: "agent-a",
	name: "Agent A",
	machine_id: "machine-a",
	machine_name: "Cloud",
	sort_order: 0,
	agent_type: "hermes",
	agent_version: null,
	os: "linux",
	last_seen_at: null,
	queue_depth_high_water: 0,
	dropped_count: 0,
	sync_enabled: true,
	explicit_identity: true,
	default_project_id: "project-a",
};

const session: components["schemas"]["SessionDetailResponse"] = {
	id: "session-a",
	local_session_id: "local-a",
	project_path: null,
	agent_type: "hermes",
	started_at: "2026-10-01T00:00:00Z",
	ended_at: null,
	updated_at: "2026-10-01T00:00:00Z",
	last_activity_at: "2026-10-01T00:00:00Z",
	duration_seconds: null,
	message_count: 2,
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	model: null,
	models_used: null,
	summary: null,
	tags: null,
	status: "completed",
	content_hash: "hash-a",
	content_protocol: "events-v1",
	is_shared: false,
	has_content: true,
};

describe("Cloud read client over HTTP", () => {
	test("preserves query encoding, owner auth, transcript revisions and paging without retries", async () => {
		const requests: ObservedRequest[] = [];
		let revision = "events:revision-a";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push({
					url: request.url,
					method: request.method,
					authorization: request.headers.get("Authorization"),
				});
				const url = new URL(request.url);
				if (request.headers.get("Authorization") !== "Bearer owner-a") {
					return Response.json({ detail: "Not found" }, { status: 404 });
				}
				if (url.pathname === "/v1/agents") return Response.json([agent]);
				if (url.pathname.startsWith("/v1/agents/")) return Response.json(agent);
				if (url.pathname === "/v1/sessions") {
					return Response.json({
						items: [],
						total: 0,
						page: Number(url.searchParams.get("page")),
						page_size: Number(url.searchParams.get("page_size")),
					} satisfies components["schemas"]["Paginated_SessionListItemResponse_"]);
				}
				if (url.pathname === "/v1/sessions/session-a") return Response.json(session);
				if (url.searchParams.get("content_revision") !== revision) {
					return Response.json(
						{ detail: { code: "session_content_revision_changed", message: "Refresh" } },
						{ status: 409 },
					);
				}
				const offset = Number(url.searchParams.get("offset"));
				return Response.json({
					content_revision: revision,
					items:
						offset === 0
							? [{ kind: "message", position: 0, role: "user", content: "Hello" }]
							: [{ kind: "tool_call", position: 1, call_id: "call-a", name: "read" }],
					total: 2,
					offset,
					limit: 1,
				} satisfies components["schemas"]["SessionTimelinePage"]);
			},
		});
		let token = "owner-a";
		const client = createCloudApiClient({
			...options,
			baseUrl: server.url.href,
			getToken: async () => token,
			fetch: (request, init) => fetch(request, init),
		});
		try {
			expect(await client.listAgents({ project_id: "project &+/%?" })).toEqual([agent]);
			expect(await client.getAgent("agent/a?owner=other#secret")).toEqual(agent);
			const query = '"hello" &owner=other +%_你好';
			expect(
				await client.listSessions({
					q: query,
					environment_id: "agent-a",
					model: ["model+one", "model&two"],
					tag: ["one/two", "tag%_"],
					page: 3,
					page_size: 10,
				}),
			).toEqual({ items: [], total: 0, page: 3, page_size: 10 });
			expect(await client.getSession("session-a")).toEqual(session);
			const transcriptQuery = {
				limit: 1,
				content_revision: revision,
				include: ["user", "tools"],
				anchor_kind: "event_seq",
				anchor_position: 10,
				anchor_revision: revision,
				search_query: query,
			} as const;
			const first = await client.getSessionMessages("session-a", {
				...transcriptQuery,
				include: [...transcriptQuery.include],
				offset: 0,
			});
			const second = await client.getSessionMessages("session-a", {
				...transcriptQuery,
				include: [...transcriptQuery.include],
				offset: 1,
			});
			expect(first.content_revision).toBe(second.content_revision);
			expect(second.items).toMatchObject([{ kind: "tool_call", position: 1 }]);
			revision = "events:revision-b";
			await expect(
				client.getSessionMessages("session-a", {
					offset: 1,
					content_revision: first.content_revision,
				}),
			).rejects.toMatchObject({ status: 409, code: "session_content_revision_changed" });
			token = "owner-b";
			await expect(client.getSession("session-a")).rejects.toMatchObject({ status: 404 });
			expect(requests).toHaveLength(8);
			expect(requests.every((request) => request.method === "GET")).toBe(true);
			expect(new URL(requests[0].url).searchParams.get("project_id")).toBe("project &+/%?");
			expect(new URL(requests[1].url).pathname).toBe(
				"/v1/agents/agent%2Fa%3Fowner%3Dother%23secret",
			);
			const listUrl = new URL(requests[2].url);
			expect(listUrl.searchParams.get("q")).toBe(query);
			expect(listUrl.searchParams.get("owner")).toBeNull();
			expect(listUrl.searchParams.getAll("model")).toEqual(["model+one", "model&two"]);
			expect(listUrl.searchParams.getAll("tag")).toEqual(["one/two", "tag%_"]);
			const pageUrl = new URL(requests[4].url);
			expect(pageUrl.searchParams.getAll("include")).toEqual(["user", "tools"]);
			expect(pageUrl.searchParams.get("anchor_revision")).toBe("events:revision-a");
			expect(pageUrl.searchParams.get("search_query")).toBe(query);
			expect(requests[7].authorization).toBe("Bearer owner-b");
		} finally {
			await server.stop(true);
		}
	});
});

describe("read transport boundaries", () => {
	test.each([null, "", " bearer-token ", "token\r\nInjected: value"])(
		"refuses missing or malformed auth without a network request",
		async (token) => {
			let calls = 0;
			const client = createCloudApiClient({
				...options,
				getToken: async () => token,
				fetch: async () => {
					calls += 1;
					return Response.json([]);
				},
			});
			await expect(client.listAgents()).rejects.toMatchObject({ category: "unauthenticated" });
			expect(calls).toBe(0);
		},
	);

	test("token acquisition failure is public and does not trigger refresh or retry", async () => {
		let tokenCalls = 0;
		const client = createCloudApiClient({
			...options,
			getToken: async () => {
				tokenCalls += 1;
				throw new Error("SDK private diagnostic");
			},
		});
		await expect(client.listAgents()).rejects.toEqual(new ApiClientError(401, "token_unavailable"));
		expect(tokenCalls).toBe(1);
	});

	test("abort during auth rejects immediately and a late token cannot start a request", async () => {
		const token = Promise.withResolvers<string | null>();
		const controller = new AbortController();
		let fetchCalls = 0;
		const client = createCloudApiClient({
			...options,
			getToken: () => token.promise,
			fetch: async () => {
				fetchCalls += 1;
				return Response.json([]);
			},
		});
		const pending = client.listAgents(undefined, controller.signal);
		const reason = new Error("Account generation retired");
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		token.resolve("old-owner-token");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetchCalls).toBe(0);
	});

	test("already aborted requests do not even acquire a token", async () => {
		let tokenCalls = 0;
		const client = createCloudApiClient({
			...options,
			getToken: async () => {
				tokenCalls += 1;
				return "owner-token";
			},
		});
		const controller = new AbortController();
		controller.abort();
		await expect(client.listAgents(undefined, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(tokenCalls).toBe(0);
	});

	test("timeout includes stalled auth and blocks its late token", async () => {
		const token = Promise.withResolvers<string | null>();
		let fetchCalls = 0;
		const client = createCloudApiClient({
			...options,
			timeoutMs: 20,
			getToken: () => token.promise,
			fetch: async () => {
				fetchCalls += 1;
				return Response.json([]);
			},
		});
		await expect(client.listAgents()).rejects.toEqual(new ApiClientNetworkError("timeout"));
		token.resolve("late-token");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetchCalls).toBe(0);
	});

	test.each(["abort", "timeout"])("%s still applies after response headers", async (mode) => {
		const controller = new AbortController();
		const headersReceived = Promise.withResolvers<void>();
		let requestSignal: AbortSignal | undefined;
		const client = createCloudApiClient({
			...options,
			timeoutMs: mode === "timeout" ? 20 : 20_000,
			fetch: async (request) => {
				requestSignal = request.signal;
				const body = new ReadableStream<Uint8Array>({
					start(stream) {
						stream.enqueue(new TextEncoder().encode("["));
						request.signal.addEventListener("abort", () => stream.error(new Error("aborted")), {
							once: true,
						});
					},
				});
				headersReceived.resolve();
				return new Response(body);
			},
		});
		const pending = client.listAgents(undefined, controller.signal);
		await headersReceived.promise;
		if (mode === "abort") controller.abort(new Error("Cancelled during body read"));
		if (mode === "timeout") {
			await expect(pending).rejects.toEqual(new ApiClientNetworkError("timeout"));
		} else {
			await expect(pending).rejects.toBe(controller.signal.reason);
		}
		expect(requestSignal?.aborted).toBe(true);
	});

	test("a late response after account abort cannot notify the observer", async () => {
		const response = Promise.withResolvers<Response>();
		const started = Promise.withResolvers<void>();
		const controller = new AbortController();
		let observations = 0;
		const client = createCloudApiClient({
			...options,
			fetch: () => {
				started.resolve();
				return response.promise;
			},
			observeResponse: () => {
				observations += 1;
			},
		});
		const pending = client.listAgents(undefined, controller.signal);
		await started.promise;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		response.resolve(Response.json([]));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(observations).toBe(0);
	});

	test.each([
		[401, "unauthenticated"],
		[403, "forbidden"],
		[404, "not_found"],
		[409, "conflict"],
		[412, "conflict"],
		[422, "invalid_request"],
		[429, "rate_limited"],
		[503, "server"],
	] as const)("keeps HTTP %i public and does not retry", async (status, category) => {
		let calls = 0;
		let observedCode: unknown;
		const client = createCloudApiClient({
			...options,
			fetch: async () => {
				calls += 1;
				return Response.json(
					{ detail: { code: "account_suspended", message: "Internal diagnostic" } },
					{ status, headers: { "Retry-After": "0" } },
				);
			},
			observeResponse: async (response) => {
				observedCode = await response.json();
			},
		});
		await expect(client.listAgents()).rejects.toMatchObject({
			status,
			category,
			code: "account_suspended",
			message: `API request failed (${status})`,
		});
		expect(observedCode).toMatchObject({ detail: { code: "account_suspended" } });
		expect(calls).toBe(1);
	});

	test("distinguishes offline, invalid JSON, empty success and HTML gateway errors", async () => {
		const offline = createCloudApiClient({
			...options,
			fetch: async () => {
				throw new Error("Private transport diagnostic");
			},
		});
		await expect(offline.listAgents()).rejects.toEqual(new ApiClientNetworkError("offline"));
		for (const response of [new Response("{"), new Response(null, { status: 204 })]) {
			const client = createCloudApiClient({ ...options, fetch: async () => response });
			await expect(client.listAgents()).rejects.toBeInstanceOf(ApiClientResponseError);
		}
		const gateway = createCloudApiClient({
			...options,
			fetch: async () => new Response("<h1>Internal upstream diagnostic</h1>", { status: 502 }),
		});
		await expect(gateway.listAgents()).rejects.toEqual(new ApiClientError(502));
	});

	test("rejects invalid configuration and path identities without network access", async () => {
		for (const baseUrl of [
			"ftp://host",
			"https://user:pass@host",
			"https://host?token=secret",
			"https://host#secret",
		]) {
			expect(() => createCloudApiClient({ ...options, baseUrl })).toThrow(TypeError);
		}
		for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => createCloudApiClient({ ...options, timeoutMs })).toThrow(TypeError);
		}
		const client = createCloudApiClient(options);
		for (const identity of ["", " ", ".", ".."]) {
			await expect(client.getAgent(identity)).rejects.toMatchObject({
				code: "invalid_resource_id",
			});
		}
	});
});

describe("Hosted read client", () => {
	test("does not mistake a snapshot handoff for an ordinary deployment inventory", async () => {
		const client = createHostedApiClient({
			...options,
			fetch: async () =>
				Response.json({
					deployments: [],
					operations: [],
					event_stream_cursor: "cursor-a",
					read_only: true,
					snapshot_isolation: "REPEATABLE READ",
				}),
		});
		await expect(client.listDeployments()).rejects.toBeInstanceOf(ApiClientResponseError);
	});

	test("uses canonical v2 routes behind an existing proxy prefix and returns request lineage", async () => {
		const requests: ObservedRequest[] = [];
		const operation: DeployComponents["schemas"]["LongRunningOperation"] = {
			name: "operations/operation-a",
			done: false,
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: "hdep-a",
				verb: "create",
				targetGeneration: 1,
				manifestETag: "etag-a",
				createTime: "2026-10-01T00:00:00Z",
				updateTime: "2026-10-01T00:00:00Z",
			},
		};
		const lineage: DeployRequestRead = {
			deploy_request_id: "request-a",
			request_status: "processing",
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const authorization = request.headers.get("Authorization");
				requests.push({ url: request.url, method: request.method, authorization });
				if (authorization !== "Bearer owner-token") {
					return Response.json({ detail: "Unauthorized" }, { status: 401 });
				}
				const path = new URL(request.url).pathname;
				if (path === "/proxy/v2/deployments") return Response.json([]);
				if (path.startsWith("/proxy/v2/deployments/by-request/")) return Response.json(lineage);
				if (path.startsWith("/proxy/v2/operations/")) return Response.json(operation);
				return Response.json({ detail: "Not found" }, { status: 404 });
			},
		});
		const client = createHostedApiClient({
			...options,
			baseUrl: new URL("/proxy/v2/", server.url).href,
			fetch: (request, init) => fetch(request, init),
		});
		try {
			expect(await client.listDeployments()).toEqual([]);
			expect(await client.getDeploymentByRequest("request/a?next=other")).toEqual(lineage);
			await expect(client.getDeployment("hdep/a")).rejects.toMatchObject({ status: 404 });
			expect(await client.getOperation("operation/a")).toEqual(operation);
			expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
				"/proxy/v2/deployments",
				"/proxy/v2/deployments/by-request/request%2Fa%3Fnext%3Dother",
				"/proxy/v2/deployments/hdep%2Fa",
				"/proxy/v2/operations/operation%2Fa",
			]);
			expect(
				requests.every((request) => request.authorization === "Bearer owner-token"),
			).toBe(true);
			expect(requests.every((request) => request.method === "GET")).toBe(true);
		} finally {
			await server.stop(true);
		}
	});
});
