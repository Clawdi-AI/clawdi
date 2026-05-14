import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	agentProjectsListCommand,
	agentProjectsReorderCommand,
} from "../../src/commands/agent-projects";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-agent-projects-${Date.now()}-${Math.random().toString(36)}`);
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
	process.exitCode = undefined;
});

describe("agent project commands", () => {
	it("prints Home and attached project sections with order copy", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/agents/agent-1/project-bindings",
				response: () =>
					jsonResponse([
						{
							id: "attach-primary",
							agent_id: "agent-1",
							project_id: "project-1",
							binding_type: "primary",
							priority: 0,
							default_write_enabled: true,
							created_at: "2026-05-14T00:00:00Z",
						},
						{
							id: "attach-shared",
							agent_id: "agent-1",
							project_id: "project-2",
							binding_type: "context",
							priority: 1,
							default_write_enabled: false,
							created_at: "2026-05-14T00:00:00Z",
						},
					]),
			},
			{
				method: "GET",
				path: "/api/projects",
				response: () =>
					jsonResponse([
						{
							id: "project-1",
							slug: "engineering",
							name: "Engineering",
							kind: "workspace",
							is_owner: true,
						},
						{
							id: "project-2",
							slug: "shared-toolkit",
							name: "Shared Toolkit",
							kind: "workspace",
							is_owner: false,
							owner_handle: "alice-a3b4",
							owner_display: "Alice",
						},
					]),
			},
		]);
		const orig = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			await agentProjectsListCommand("agent-1");
		} finally {
			console.log = orig;
			restore();
		}

		const out = lines.join("\n");
		expect(out).toContain("Projects used by agent-1");
		expect(out).toContain("Home project");
		expect(out).toContain("Attached projects (1)");
		expect(out).toContain("@alice-a3b4/shared-toolkit");
		expect(out).toContain("viewer");
		expect(out).toContain("Order matters: Home wins first, then attached projects in order.");
		expect(out).toContain(
			"Reorder: clawdi agent projects reorder agent-1 --item <attachment-id>:1",
		);
		expect(out).not.toMatch(/\bbind(ing|s)?\b/i);
		expect(out).not.toContain("context project");
	});

	it("lists API rows with project metadata in JSON", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/agents/agent-1/project-bindings",
				response: () =>
					jsonResponse([
						{
							id: "binding-1",
							agent_id: "agent-1",
							project_id: "project-1",
							binding_type: "primary",
							priority: 0,
							default_write_enabled: true,
							created_at: "2026-05-14T00:00:00Z",
						},
					]),
			},
			{
				method: "GET",
				path: "/api/projects",
				response: () =>
					jsonResponse([
						{
							id: "project-1",
							slug: "engineering",
							name: "Engineering",
							kind: "workspace",
							is_owner: true,
						},
					]),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await agentProjectsListCommand("agent-1", { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(JSON.parse(out).bindings[0].project.slug).toBe("engineering");
	});

	it("sends reorder items to the backend", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "PATCH",
				path: "/api/agents/agent-1/project-bindings/context/reorder",
				response: () => jsonResponse({ status: "reordered" }),
			},
		]);
		try {
			await agentProjectsReorderCommand("agent-1", {
				item: ["binding-a:2", "binding-b:1"],
			});
		} finally {
			restore();
		}

		expect(captured[0].body).toEqual({
			items: [
				{ binding_id: "binding-a", priority: 2 },
				{ binding_id: "binding-b", priority: 1 },
			],
		});
	});
});
