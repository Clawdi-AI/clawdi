import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryAdd } from "../../src/commands/memory";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-memory-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://api.test";
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("memoryAdd", () => {
	it("rejects likely secrets before posting", async () => {
		const { captured, restore } = mockFetch([]);

		try {
			await expect(memoryAdd("OpenAI key is sk-abcdefghijklmnopqrstuvwxyz123456")).rejects.toThrow(
				"Store secrets with `clawdi vault set <KEY> --stdin`",
			);
		} finally {
			restore();
		}

		expect(captured).toHaveLength(0);
	});

	it("posts ordinary memories", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/memories",
				response: () => jsonResponse({ id: "00000000-0000-0000-0000-000000000abc" }),
			},
		]);
		const origLog = console.log;
		console.log = () => {};

		try {
			await memoryAdd("The user prefers concise PR summaries.", {
				category: "preference",
			});
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].body).toEqual({
			content: "The user prefers concise PR summaries.",
			category: "preference",
			source: "manual",
		});
	});
});
