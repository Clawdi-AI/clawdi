import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inboxAcceptCommand } from "../../src/commands/inbox";
import { scopeMountCommand } from "../../src/commands/scope-mount";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-json-paths-${Date.now()}-${Math.random().toString(36)}`);
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

describe("agent JSON paths", () => {
	it("inbox accept --json emits joined payload plus eager-pull count", async () => {
		const token = "a".repeat(43);
		const { restore } = mockFetch([
			{
				method: "POST",
				path: `/api/share/${token}/upgrade`,
				response: () =>
					jsonResponse({
						scope_id: "scope-shared",
						resolved_owner_handle: "alice-1234",
						membership_id: "membership-1",
						mount_id: "mount-1",
						mount_alias: "@alice-1234/shared",
						mount_parent_scope_id: "scope-parent",
					}),
			},
			{
				method: "GET",
				path: "/api/skills",
				response: () => jsonResponse({ items: [] }),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await inboxAcceptCommand(token, { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(JSON.parse(out)).toMatchObject({
			status: "joined",
			pulled_skills: 0,
			scope_id: "scope-shared",
			mount_alias: "@alice-1234/shared",
		});
	});

	it("scope mount --json emits the created mount", async () => {
		const scopes = [
			{ id: "scope-parent", slug: "personal", name: "Personal", kind: "personal" },
			{ id: "scope-source", slug: "shared", name: "Shared", kind: "environment" },
		];
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/api/scopes/scope-parent/mounts",
				response: () =>
					jsonResponse({
						id: "mount-1",
						parent_scope_id: "scope-parent",
						source_scope_id: "scope-source",
						source_scope_name: "Shared",
						source_scope_slug: "shared",
						source_owner_display: "Alice",
						source_owner_handle: "alice-1234",
						alias: "@alice-1234/shared",
						mode: "live",
						created_at: "2026-05-12T10:00:00Z",
					}),
			},
			{ method: "GET", path: "/api/scopes", response: () => jsonResponse(scopes) },
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await scopeMountCommand("shared", { into: "personal", json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(JSON.parse(out)).toMatchObject({
			status: "mounted",
			mount: { id: "mount-1", alias: "@alice-1234/shared" },
		});
	});
});
