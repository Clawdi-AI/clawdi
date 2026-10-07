import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectRmCommand } from "../../src/commands/project-rm";
import { jsonResponse, mockFetch } from "./helpers";

const projectId = "00000000-0000-0000-0000-000000000123";
let tmpHome: string;
let originalHome: string | undefined;
let originalApiUrl: string | undefined;

beforeEach(() => {
	originalHome = process.env.HOME;
	originalApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = mkdtempSync(join(tmpdir(), "clawdi-project-rm-"));
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(
		join(tmpHome, ".clawdi", "auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			endpointBinding: { version: 1, cloudApiOrigin: "https://api.test" },
		}),
	);
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "https://api.test";
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalApiUrl === undefined) delete process.env.CLAWDI_API_URL;
	else process.env.CLAWDI_API_URL = originalApiUrl;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("projectRmCommand", () => {
	it("archives a project and emits the versioned JSON result", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "DELETE",
				path: `/v1/projects/${projectId}`,
				response: () => new Response(null, { status: 204 }),
			},
		]);
		const output: string[] = [];
		const originalLog = console.log;
		console.log = (value?: unknown) => output.push(String(value));
		try {
			await projectRmCommand(projectId, { yes: true, json: true });
		} finally {
			console.log = originalLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({ method: "DELETE", path: `/v1/projects/${projectId}` });
		expect(JSON.parse(output[0] ?? "{}")).toEqual({
			schemaVersion: "clawdi.projectRm.v1",
			id: projectId,
			status: "archived",
		});
	});

	it("requires confirmation in a non-interactive shell", async () => {
		const { captured, restore } = mockFetch([]);
		try {
			await expect(projectRmCommand(projectId)).rejects.toThrow(
				"Confirmation required to archive this project",
			);
			expect(captured).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("maps non-workspace archive failures to an actionable message", async () => {
		const { restore } = mockFetch([
			{
				method: "DELETE",
				path: `/v1/projects/${projectId}`,
				response: () => jsonResponse({ detail: "Only workspace projects can be archived" }, 403),
			},
		]);
		try {
			await expect(projectRmCommand(projectId, { yes: true })).rejects.toThrow(
				"This project can't be archived (only projects you created).",
			);
		} finally {
			restore();
		}
	});
});
