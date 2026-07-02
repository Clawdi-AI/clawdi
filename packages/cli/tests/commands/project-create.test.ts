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
	process.exitCode = 0;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpHome, { recursive: true, force: true });
	process.exitCode = 0;
});

describe("projectCreateCommand", () => {
	it("posts a user-created Project and emits agent JSON", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/projects",
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
			path: "/v1/projects",
			body: { name: "Client Alpha", slug: "client-alpha" },
		});
		expect(JSON.parse(out)).toMatchObject({
			status: "created",
			project: { id: "project-workspace", slug: "client-alpha", kind: "workspace" },
		});
	});

	it("formats non-JSON validation errors without reading the body twice", async () => {
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/projects",
				response: () =>
					new Response("slug already exists", {
						status: 409,
						headers: { "content-type": "text/plain" },
					}),
			},
		]);
		const origError = console.error;
		let err = "";
		console.error = (...args: unknown[]) => {
			err = args.map(String).join(" ");
		};
		try {
			await projectCreateCommand("Client Alpha");
		} finally {
			console.error = origError;
			restore();
		}

		const observedExitCode = process.exitCode;
		process.exitCode = 0;
		expect(observedExitCode).toBe(1);
		expect(err).toContain("slug already exists");
	});
});
