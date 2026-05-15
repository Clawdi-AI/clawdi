import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectShowCommand } from "../../src/commands/project-show";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-project-show-${Date.now()}-${Math.random().toString(36)}`);
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

describe("projectShowCommand", () => {
	it("prints shared project role, owner, and exact follow-up commands", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/projects",
				response: () =>
					jsonResponse([
						{
							id: "project-shared",
							slug: "shared-toolkit",
							name: "Shared Toolkit",
							kind: "workspace",
							is_owner: false,
							owner_display: "Alice",
							owner_handle: "alice-a3b4",
						},
					]),
			},
			{
				method: "GET",
				path: "/api/skills?page=1&page_size=200",
				response: () =>
					jsonResponse({
						items: [{ project_id: "project-shared", skill_key: "deploy-helper" }],
						total: 1,
					}),
			},
			{
				method: "GET",
				path: "/api/vault?page_size=200",
				response: () =>
					jsonResponse({
						items: [{ project_id: "project-shared", slug: "prod", name: "Production" }],
					}),
			},
		]);
		const orig = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			await projectShowCommand("@alice-a3b4/shared-toolkit");
		} finally {
			console.log = orig;
			restore();
		}

		const out = lines.join("\n");
		expect(out).toContain("Role: viewer");
		expect(out).toContain("Owner: Alice (@alice-a3b4)");
		expect(out).toContain("Access: read-only project access");
		expect(out).toContain("Resources");
		expect(out).toContain("Use with agent:");
		expect(out).toContain(
			"clawdi agent projects attach <agent-id> --project @alice-a3b4/shared-toolkit",
		);
		expect(out).toContain("Leave: clawdi project leave @alice-a3b4/shared-toolkit");
		expect(out).not.toMatch(/\bbind(ing|s)?\b/i);
	});

	it("prints a JSON project inventory with local skill/vault counts", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/projects",
				response: () =>
					jsonResponse([
						{
							id: "project-parent",
							slug: "personal",
							name: "Personal",
							kind: "personal",
							is_owner: true,
						},
					]),
			},
			{
				method: "GET",
				path: "/api/skills?page=1&page_size=200",
				response: () =>
					jsonResponse({
						items: [
							{ project_id: "project-parent", skill_key: "local-skill" },
							{ project_id: "project-source", skill_key: "shared-skill" },
						],
						total: 2,
					}),
			},
			{
				method: "GET",
				path: "/api/vault?page_size=200",
				response: () =>
					jsonResponse({
						items: [
							{ project_id: "project-parent", slug: "prod", name: "Production" },
							{ project_id: "project-source", slug: "shared", name: "Shared" },
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
			await projectShowCommand("personal", { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const parsed = JSON.parse(out);
		expect(parsed.project.slug).toBe("personal");
		expect(parsed.skills.keys).toEqual(["local-skill"]);
		expect(parsed.vaults).toEqual([{ slug: "prod", name: "Production" }]);
	});
});
