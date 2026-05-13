import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	scopeLeaveCommand,
	scopeMembersCommand,
	scopeUnshareCommand,
} from "../../src/commands/scope-members";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-scope-members-${Date.now()}-${Math.random().toString(36)}`);
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

const scopes = [
	{
		id: "scope-owned",
		slug: "engineering",
		name: "Engineering",
		kind: "environment",
		is_owner: true,
	},
	{
		id: "scope-shared",
		slug: "shared-toolkit",
		name: "Shared Toolkit",
		kind: "environment",
		is_owner: false,
	},
];

describe("scope member lifecycle commands", () => {
	it("lists and removes accepted members with JSON output", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/api/scopes/scope-owned/members",
				response: () =>
					jsonResponse([
						{
							id: "member-1",
							user_id: "user-bob",
							user_email: "bob@example.test",
							user_display: "Bob",
							role: "viewer",
							joined_via: "link",
							joined_at: "2026-05-12T10:00:00Z",
							resolved_owner_handle: "alice-1234",
						},
					]),
			},
			{
				method: "DELETE",
				path: "/api/scopes/scope-owned/members/user-bob",
				response: () => jsonResponse({ status: "removed", mounts_removed: 1 }),
			},
			{ method: "GET", path: "/api/scopes", response: () => jsonResponse(scopes) },
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await scopeMembersCommand("engineering", { remove: "bob@example.test", json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/scopes",
			"GET /api/scopes/scope-owned/members",
			"DELETE /api/scopes/scope-owned/members/user-bob",
		]);
		expect(JSON.parse(out)).toEqual({
			scope_id: "scope-owned",
			removed_user_id: "user-bob",
			status: "removed",
			mounts_removed: 1,
		});
	});

	it("leaves a shared scope and reports removed mounts", async () => {
		const { restore } = mockFetch([
			{ method: "GET", path: "/api/scopes", response: () => jsonResponse(scopes) },
			{
				method: "POST",
				path: "/api/scopes/scope-shared/leave",
				response: () => jsonResponse({ status: "left", mounts_removed: 2 }),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await scopeLeaveCommand("shared-toolkit", { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(JSON.parse(out)).toEqual({
			scope_id: "scope-shared",
			status: "left",
			mounts_removed: 2,
		});
	});

	it("unshares an owned scope", async () => {
		const { restore } = mockFetch([
			{ method: "GET", path: "/api/scopes", response: () => jsonResponse(scopes) },
			{
				method: "POST",
				path: "/api/scopes/scope-owned/unshare",
				response: () =>
					jsonResponse({
						links_revoked: 1,
						members_removed: 2,
						invitations_cancelled: 3,
					}),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await scopeUnshareCommand("engineering", { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(JSON.parse(out)).toEqual({
			scope_id: "scope-owned",
			links_revoked: 1,
			members_removed: 2,
			invitations_cancelled: 3,
		});
	});
});
