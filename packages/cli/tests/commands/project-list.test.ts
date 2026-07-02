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
	it("prints ownership groups with collaboration next actions", async () => {
		const projects = [
			{
				id: "project-owned",
				slug: "engineering",
				name: "Engineering",
				kind: "workspace",
				is_owner: true,
			},
			{
				id: "project-shared",
				slug: "shared-toolkit",
				name: "Shared Toolkit",
				kind: "workspace",
				is_owner: false,
				owner_display: "Alice",
				owner_handle: "alice-a3b4",
			},
		];
		const { restore } = mockFetch([
			{ method: "GET", path: "/v1/projects", response: () => jsonResponse(projects) },
		]);
		const orig = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			await projectListCommand({});
		} finally {
			console.log = orig;
			restore();
		}

		const out = lines.join("\n");
		expect(out).toContain("My projects (1)");
		expect(out).toContain("Shared with me (1)");
		expect(out).toContain("@alice-a3b4/shared-toolkit");
		expect(out).toContain("viewer");
		expect(out).toContain("Open:  clawdi project show @alice-a3b4/shared-toolkit");
		expect(out).toContain(
			"Attach to Agent: clawdi agent projects attach <agent-id> --project @alice-a3b4/shared-toolkit",
		);
		expect(out).not.toMatch(/\bbind(ing|s)?\b/i);
		expect(out).not.toContain("context boundary");
	});

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
			{ method: "GET", path: "/v1/projects", response: () => jsonResponse(projects) },
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
		expect(parsed.environment_projects).toEqual([]);
		expect(parsed.hidden_environment_project_count).toBe(0);
	});

	it("hides machine environment projects by default and can include them", async () => {
		const projects = [
			{ id: "project-a", slug: "personal", name: "Personal", kind: "personal", is_owner: true },
			{
				id: "project-env",
				slug: "env-abc123",
				name: "Workstation (codex)",
				kind: "environment",
				is_owner: true,
			},
		];
		const { restore } = mockFetch([
			{ method: "GET", path: "/v1/projects", response: () => jsonResponse(projects) },
		]);
		const orig = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await projectListCommand({});
			const hiddenOut = lines.join("\n");
			expect(hiddenOut).toContain("My projects (1)");
			expect(hiddenOut).not.toContain("env-abc123");
			expect(hiddenOut).toContain("Hidden machine projects: 1");

			lines.length = 0;
			await projectListCommand({ includeEnvs: true });
			const includedOut = lines.join("\n");
			expect(includedOut).toContain("Machines (1)");
			expect(includedOut).toContain("env-abc123");
		} finally {
			console.log = orig;
			restore();
		}
	});

	it("omits machine environment projects from JSON unless requested", async () => {
		const projects = [
			{ id: "project-a", slug: "personal", name: "Personal", kind: "personal", is_owner: true },
			{
				id: "project-env",
				slug: "env-abc123",
				name: "Workstation (codex)",
				kind: "environment",
				is_owner: true,
			},
		];
		const { restore } = mockFetch([
			{ method: "GET", path: "/v1/projects", response: () => jsonResponse(projects) },
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};

		try {
			await projectListCommand({ json: true });
			const hidden = JSON.parse(out);
			expect(hidden.projects.map((p: { slug: string }) => p.slug)).toEqual(["personal"]);
			expect(hidden.environment_projects).toEqual([]);
			expect(hidden.hidden_environment_project_count).toBe(1);

			await projectListCommand({ json: true, includeEnvs: true });
			const included = JSON.parse(out);
			expect(included.projects.map((p: { slug: string }) => p.slug)).toEqual([
				"personal",
				"env-abc123",
			]);
			expect(included.environment_projects.map((p: { slug: string }) => p.slug)).toEqual([
				"env-abc123",
			]);
			expect(included.hidden_environment_project_count).toBe(0);
		} finally {
			console.log = orig;
			restore();
		}
	});
});
