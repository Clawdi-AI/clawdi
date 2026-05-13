import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeShowCommand } from "../../src/commands/scope-show";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-scope-show-${Date.now()}-${Math.random().toString(36)}`);
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

describe("scopeShowCommand", () => {
	it("prints a JSON scope inventory with parent-owned counts and mounts", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/scopes/scope-parent/mounts",
				response: () =>
					jsonResponse([
						{
							id: "mount-1",
							parent_scope_id: "scope-parent",
							source_scope_id: "scope-source",
							source_scope_name: "Engineering",
							source_scope_slug: "engineering",
							source_owner_display: "Alice",
							source_owner_handle: "alice",
							alias: "@alice/engineering",
							mode: "live",
						},
					]),
			},
			{
				method: "GET",
				path: "/api/scopes",
				response: () =>
					jsonResponse([
						{
							id: "scope-parent",
							slug: "personal",
							name: "Personal",
							kind: "personal",
							is_owner: true,
						},
					]),
			},
			{
				method: "GET",
				path: "/api/skills",
				response: () =>
					jsonResponse({
						items: [
							{ scope_id: "scope-parent", skill_key: "local-skill" },
							{ scope_id: "scope-source", skill_key: "mounted-skill" },
						],
						total: 2,
					}),
			},
			{
				method: "GET",
				path: "/api/vault",
				response: () =>
					jsonResponse({
						items: [
							{ scope_id: "scope-parent", slug: "prod", name: "Production" },
							{ scope_id: "scope-source", slug: "shared", name: "Shared" },
						],
					}),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await scopeShowCommand("personal", { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const parsed = JSON.parse(out);
		expect(parsed.scope.slug).toBe("personal");
		expect(parsed.skills.keys).toEqual(["local-skill"]);
		expect(parsed.vaults).toEqual([{ slug: "prod", name: "Production" }]);
		expect(parsed.mounts[0].alias).toBe("@alice/engineering");
	});
});
