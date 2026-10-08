import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	sessionExport,
	sessionList,
	sessionRead,
	sessionSearch,
	sessionShareCreate,
	sessionShareList,
	sessionShareRevoke,
} from "../../src/commands/session";
import type { SessionListQuery } from "../../src/lib/api-schemas";
import { jsonResponse, mockFetch, seedAuthAndEnv } from "./helpers";

let tmpHome: string;
let originalHome: string | undefined;
let originalApiUrl: string | undefined;

beforeEach(() => {
	originalHome = process.env.HOME;
	originalApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = mkdtempSync(join(tmpdir(), "clawdi-session-command-"));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://localhost:8000";
	seedAuthAndEnv(tmpHome, "codex");
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalApiUrl === undefined) delete process.env.CLAWDI_API_URL;
	else process.env.CLAWDI_API_URL = originalApiUrl;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("cloud session commands", () => {
	it("lists uploaded sessions with the generated query contract and default options", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/sessions",
				response: () => jsonResponse({ items: [], total: 0, page: 1, page_size: 25 }),
			},
		]);
		const output = spyOn(console, "log").mockImplementation(() => {});
		try {
			await sessionList({ uploaded: true, json: true });
			expect(captured).toHaveLength(1);
			const expectedQuery = {
				page_size: 25,
				sort: "last_activity_at",
				order: "desc",
			} satisfies SessionListQuery;
			expect(Object.fromEntries(new URL(captured[0]?.url ?? "").searchParams)).toEqual(
				Object.fromEntries(
					Object.entries(expectedQuery).map(([key, value]) => [key, String(value)]),
				),
			);
			expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
				schemaVersion: "clawdi.sessionList.v2",
				sessions: [],
				total: 0,
			});
		} finally {
			output.mockRestore();
			restore();
		}
	});

	it("lists uploaded sessions without a search query", async () => {
		const sessionId = "00000000-0000-0000-0000-000000000125";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/sessions",
				response: () =>
					jsonResponse({
						items: [
							{
								id: sessionId,
								local_session_id: "local-125",
								project_path: "/workspace",
								agent_type: "codex",
								started_at: "2026-08-27T11:00:00Z",
								ended_at: "2026-08-27T11:05:00Z",
								last_activity_at: "2026-08-27T11:05:00Z",
								duration_seconds: 300,
								message_count: 4,
								input_tokens: 10,
								output_tokens: 20,
								cache_read_tokens: 0,
								model: "gpt-test",
								models_used: ["gpt-test"],
								summary: "Uploaded fixture",
								tags: [],
								status: "complete",
								content_hash: null,
								content_protocol: "snapshot-v1",
								is_shared: false,
							},
						],
						total: 2,
						page: 1,
						page_size: 1,
					}),
			},
		]);
		const output: string[] = [];
		const errors: string[] = [];
		const originalLog = console.log;
		const originalError = console.error;
		console.log = (value?: unknown) => output.push(String(value));
		console.error = (value?: unknown) => errors.push(String(value));
		try {
			await sessionList({
				uploaded: true,
				agent: "codex",
				agentId: "00000000-0000-0000-0000-000000000099",
				since: "2026-08-01",
				limit: "1",
				json: true,
			});
		} finally {
			console.log = originalLog;
			console.error = originalError;
			restore();
		}

		const query = new URL(captured[0]?.url ?? "").searchParams;
		const expectedQuery = {
			agent: "codex",
			environment_id: "00000000-0000-0000-0000-000000000099",
			page_size: 1,
			since: "2026-08-01T00:00:00.000Z",
			sort: "last_activity_at",
			order: "desc",
		} satisfies SessionListQuery;
		expect(Object.fromEntries(query)).toEqual(
			Object.fromEntries(Object.entries(expectedQuery).map(([key, value]) => [key, String(value)])),
		);
		const payload = JSON.parse(output[0] ?? "{}");
		expect(payload.schemaVersion).toBe("clawdi.sessionList.v2");
		expect(payload.sessions[0].id).toBe(sessionId);
		expect(payload.total).toBe(2);
		expect(errors).toEqual(["Showing 1 of 2; pass --limit to see more."]);
	});

	it("rejects single-character searches before making a request", async () => {
		await expect(sessionSearch(" x ")).rejects.toThrow(
			"Session search query must be at least 2 characters.",
		);
	});

	it("searches through the cloud session query contract", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/sessions",
				response: () => jsonResponse({ items: [], total: 0, page: 1, page_size: 7 }),
			},
		]);
		const originalLog = console.log;
		console.log = () => {};
		try {
			await sessionSearch("workspace setup", { agent: "codex", limit: "7", json: true });
		} finally {
			console.log = originalLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		const url = new URL(captured[0].url);
		expect(url.pathname).toBe("/v1/sessions");
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			q: "workspace setup",
			agent: "codex",
			page_size: "7",
			sort: "relevance",
		});
	});

	it("reports truncated JSON results on stderr", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/sessions",
				response: () =>
					jsonResponse({
						items: [
							{
								id: "00000000-0000-0000-0000-000000000123",
								local_session_id: "local-123",
								summary: "Fixture",
								agent_type: "codex",
								last_activity_at: "2026-08-27T12:00:00Z",
							},
						],
						total: 2,
						page: 1,
						page_size: 1,
					}),
			},
		]);
		const output: string[] = [];
		const errors: string[] = [];
		const originalLog = console.log;
		const originalError = console.error;
		console.log = (value?: unknown) => output.push(String(value));
		console.error = (value?: unknown) => errors.push(String(value));
		try {
			await sessionSearch("fixture", { limit: "1", json: true });
		} finally {
			console.log = originalLog;
			console.error = originalError;
			restore();
		}

		expect(JSON.parse(output[0]).schemaVersion).toBe("clawdi.sessionSearch.v2");
		expect(JSON.parse(output[0]).sessions).toHaveLength(1);
		expect(errors).toContain("Showing 1 of 2; pass --limit to see more.");
	});

	it("prints the best matching message excerpt in terminal output", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/sessions",
				response: () =>
					jsonResponse({
						items: [
							{
								id: "00000000-0000-0000-0000-000000000123",
								local_session_id: "local-123",
								summary: "Fixture",
								project_path: "/workspace",
								agent_type: "codex",
								last_activity_at: "2026-08-27T12:00:00Z",
								search_match: {
									role: "assistant",
									excerpt: "The matching implementation detail",
								},
							},
						],
						total: 1,
						page: 1,
						page_size: 25,
					}),
			},
		]);
		const output: string[] = [];
		const originalLog = console.log;
		const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		console.log = (value?: unknown) => output.push(String(value));
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			await sessionSearch("implementation");
		} finally {
			console.log = originalLog;
			if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
			else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
			restore();
		}

		expect(output.join("\n")).toContain("assistant: The matching implementation detail");
	});

	it("reads metadata and message content by cloud session id", async () => {
		const sessionId = "00000000-0000-0000-0000-000000000123";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: `/v1/sessions/${sessionId}/content`,
				response: () => jsonResponse([{ role: "user", content: "hello", position: 3 }]),
			},
			{
				method: "GET",
				path: `/v1/sessions/${sessionId}`,
				response: () =>
					jsonResponse({
						id: sessionId,
						local_session_id: "local-123",
						summary: "Fixture",
						agent_type: "codex",
						project_path: "/workspace",
						has_content: true,
					}),
			},
		]);
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (value?: unknown) => output.push(String(value));
		try {
			await sessionRead(sessionId, { json: true });
		} finally {
			console.log = originalLog;
			restore();
		}

		expect(captured.map((request) => request.path).sort()).toEqual(
			[`/v1/sessions/${sessionId}`, `/v1/sessions/${sessionId}/content`].sort(),
		);
		expect(JSON.parse(output[0])).toMatchObject({
			session: { id: sessionId },
			messages: [{ role: "user", content: "hello", position: 3 }],
		});
	});

	it("reads metadata-only sessions without requesting absent content", async () => {
		const sessionId = "00000000-0000-0000-0000-000000000124";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: `/v1/sessions/${sessionId}`,
				response: () =>
					jsonResponse({
						id: sessionId,
						local_session_id: "local-124",
						summary: "Metadata only",
						agent_type: "codex",
						project_path: "/workspace",
						has_content: false,
					}),
			},
		]);
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (value?: unknown) => output.push(String(value));
		try {
			await sessionRead(sessionId, { json: true });
		} finally {
			console.log = originalLog;
			restore();
		}

		expect(captured.map((request) => request.path)).toEqual([`/v1/sessions/${sessionId}`]);
		expect(JSON.parse(output[0])).toMatchObject({
			session: { id: sessionId, has_content: false },
			messages: [],
		});
	});
});

it("publishes only with confirmation and keeps canonical positions and legacy IDs", async () => {
	const { captured, restore } = mockFetch([
		{
			method: "POST",
			path: "/v1/sessions/cloud-id/shares",
			response: () => jsonResponse({ id: "snapshot-id", scope: "response", position: 3 }, 201),
		},
		{
			method: "GET",
			path: "/v1/session-shares",
			response: () => jsonResponse({ items: [], total: 0, page: 1, page_size: 25 }),
		},
		{
			method: "DELETE",
			path: "/v1/session-shares/legacy-id",
			response: () => new Response(null, { status: 204 }),
		},
	]);
	const originalLog = console.log;
	console.log = () => {};
	try {
		await expect(sessionShareCreate("cloud-id", { response: "3" })).rejects.toThrow("--yes");
		await expect(
			sessionShareCreate("cloud-id", { through: "1", response: "3", yes: true }),
		).rejects.toThrow("only one");
		expect(captured).toHaveLength(0);
		await sessionShareCreate("cloud-id", { response: "3", yes: true, json: true });
		await sessionShareList("cloud-id", { json: true });
		await sessionShareRevoke("legacy-id", { legacy: true, yes: true, json: true });
		expect(captured[0]?.body).toEqual({ scope: "response", position: 3 });
		expect(new URL(captured[1]?.url ?? "").searchParams.get("session_id")).toBe("cloud-id");
		expect(new URL(captured[2]?.url ?? "").searchParams.get("kind")).toBe("live");
	} finally {
		console.log = originalLog;
		restore();
	}
});

it("exports owner Markdown without publishing a link", async () => {
	const { captured, restore } = mockFetch([
		{
			method: "GET",
			path: "/v1/sessions/cloud-id/export.md",
			response: () =>
				new Response("# Private session\n", { headers: { "Content-Type": "text/markdown" } }),
		},
	]);
	const write = spyOn(process.stdout, "write").mockImplementation(() => true);
	try {
		await sessionExport("cloud-id");
		expect(write).toHaveBeenCalledWith("# Private session\n");
		expect(captured.map((item) => item.method)).toEqual(["GET"]);
	} finally {
		write.mockRestore();
		restore();
	}
});
