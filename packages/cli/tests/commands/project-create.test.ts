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
	writeFileSync(
		join(tmpHome, ".clawdi", "auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			endpointBinding: { version: 1, cloudApiOrigin: "https://api.test" },
		}),
	);
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "https://api.test";
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
			schemaVersion: "clawdi.projectCreate.v1",
			status: "created",
			project: { id: "project-workspace", slug: "client-alpha", kind: "workspace" },
		});
	});

	it.each([400, 403, 409, 422, 500])(
		"reports HTTP %s errors without backend details",
		async (status) => {
			const { restore } = mockFetch([
				{
					method: "POST",
					path: "/v1/projects",
					response: () =>
						new Response("private backend internals", {
							status,
							headers: { "content-type": "text/plain" },
						}),
				},
			]);
			const origError = console.error;
			const origLog = console.log;
			const errors: unknown[] = [];
			const output: unknown[] = [];
			console.log = (...args: unknown[]) => output.push(...args);
			console.error = (...args: unknown[]) => errors.push(...args);
			try {
				const operation = projectCreateCommand("Client Alpha", { json: true });
				await expect(operation).rejects.toThrow(`API error ${status}`);
				await expect(operation).rejects.toMatchObject({
					message: expect.not.stringContaining("private backend internals"),
				});
			} finally {
				console.error = origError;
				console.log = origLog;
				restore();
			}

			expect(output).toEqual([]);
			expect(errors).toEqual([]);
		},
	);
});
