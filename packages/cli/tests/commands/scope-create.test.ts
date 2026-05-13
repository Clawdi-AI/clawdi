import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scopeCreateCommand } from "../../src/commands/scope-create";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-scope-create-${Date.now()}-${Math.random().toString(36)}`);
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

describe("scopeCreateCommand", () => {
	it("posts a workspace scope and emits agent JSON", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/scopes",
				response: () =>
					jsonResponse(
						{
							id: "scope-workspace",
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
			await scopeCreateCommand("Client Alpha", { slug: "Client Alpha", json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(captured[0]).toMatchObject({
			method: "POST",
			path: "/api/scopes",
			body: { name: "Client Alpha", slug: "client-alpha" },
		});
		expect(JSON.parse(out)).toMatchObject({
			status: "created",
			scope: { id: "scope-workspace", slug: "client-alpha", kind: "workspace" },
		});
	});
});
