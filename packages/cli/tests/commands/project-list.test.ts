import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectListCommand } from "../../src/commands/project-list";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-project-list-${Date.now()}-${Math.random().toString(36)}`);
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

describe("projectListCommand", () => {
	it("prints JSON grouped by ownership", async () => {
		const projects = [
			{ id: "project-a", slug: "personal", name: "Personal", kind: "personal", is_owner: true },
			{
				id: "project-b",
				slug: "engineering",
				name: "Engineering",
				kind: "workspace",
				is_owner: true,
			},
			{
				id: "project-c",
				slug: "shared-toolkit",
				name: "Shared Toolkit",
				kind: "workspace",
				is_owner: false,
				owner_display: "Alice",
				owner_handle: "alice-a3b4",
			},
		];
		const { restore } = mockFetch([
			{ method: "GET", path: "/api/projects", response: () => jsonResponse(projects) },
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await projectListCommand({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const parsed = JSON.parse(out);
		expect(parsed.owned_projects.map((p: { slug: string }) => p.slug)).toEqual([
			"personal",
			"engineering",
		]);
		expect(parsed.shared_projects.map((p: { slug: string }) => p.slug)).toEqual(["shared-toolkit"]);
		expect(parsed.shared_projects[0].owner_handle).toBe("alice-a3b4");
		expect(parsed.projects).toHaveLength(3);
	});
});
