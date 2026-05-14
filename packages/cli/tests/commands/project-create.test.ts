import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectCreateCommand } from "../../src/commands/project-create";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-project-create-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://api.test";
	process.exitCode = undefined;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpHome, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe("projectCreateCommand", () => {
	it("posts a workspace project and emits agent JSON", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/projects",
				response: () =>
					jsonResponse(
						{
							id: "project-workspace",
							slug: "client-alpha",
							name: "Client Alpha",
							kind: "workspace",
							is_owner: true,
						},
						201,
					),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await projectCreateCommand("Client Alpha", { slug: "Client Alpha", json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(captured[0]).toMatchObject({
			method: "POST",
			path: "/api/projects",
			body: { name: "Client Alpha", slug: "client-alpha" },
		});
		expect(JSON.parse(out)).toMatchObject({
			status: "created",
			project: { id: "project-workspace", slug: "client-alpha", kind: "workspace" },
		});
	});
});
