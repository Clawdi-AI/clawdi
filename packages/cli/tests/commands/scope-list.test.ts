import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scopeListCommand } from "../../src/commands/scope-list";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-scope-list-${Date.now()}-${Math.random().toString(36)}`);
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

describe("scopeListCommand", () => {
	it("does not report a shared scope as pending when it is mounted into any parent", async () => {
		const scopes = [
			{
				id: "parent-a",
				slug: "personal",
				name: "Personal",
				kind: "personal",
				is_owner: true,
			},
			{
				id: "parent-b",
				slug: "client",
				name: "Client",
				kind: "environment",
				is_owner: true,
			},
			{
				id: "shared-1",
				slug: "engineering",
				name: "Engineering",
				kind: "environment",
				is_owner: false,
			},
			{
				id: "shared-2",
				slug: "design",
				name: "Design",
				kind: "environment",
				is_owner: false,
			},
		];
		const mountedEngineering = {
			id: "mount-1",
			parent_scope_id: "parent-a",
			source_scope_id: "shared-1",
			source_scope_name: "Engineering",
			source_scope_slug: "engineering",
			source_owner_display: "Alice",
			source_owner_handle: "alice-1234",
			alias: "@alice-1234/engineering",
			mode: "live",
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/scopes/parent-a/mounts",
				response: () => jsonResponse([mountedEngineering]),
			},
			{
				method: "GET",
				path: "/api/scopes/parent-b/mounts",
				response: () => jsonResponse([]),
			},
			{ method: "GET", path: "/api/scopes", response: () => jsonResponse(scopes) },
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await scopeListCommand({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const parsed = JSON.parse(out);
		expect(parsed.shared_mounted.map((s: { slug: string }) => s.slug)).toEqual(["engineering"]);
		expect(parsed.shared_mounted[0].mounts).toEqual([mountedEngineering]);
		expect(parsed.shared_pending_mount.map((s: { slug: string }) => s.slug)).toEqual(["design"]);
	});
});
