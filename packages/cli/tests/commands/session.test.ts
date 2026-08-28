import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRead, sessionSearch } from "../../src/commands/session";
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
				response: () => jsonResponse([{ role: "user", content: "hello" }]),
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
			messages: [{ role: "user", content: "hello" }],
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
