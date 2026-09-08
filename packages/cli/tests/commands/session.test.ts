import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	sessionExport,
	sessionRead,
	sessionSearch,
	sessionShareCreate,
	sessionShareList,
	sessionShareRevoke,
} from "../../src/commands/session";
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
