import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	projectLeaveCommand,
	projectMembersCommand,
	projectUnshareCommand,
} from "../../src/commands/project-members";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-project-members-${Date.now()}-${Math.random().toString(36)}`);
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

const projects = [
	{
		id: "project-owned",
		slug: "engineering",
		name: "Engineering",
		kind: "environment",
		is_owner: true,
	},
	{
		id: "project-shared",
		slug: "shared-toolkit",
		name: "Shared Toolkit",
		kind: "environment",
		is_owner: false,
		owner_display: "Alice",
		owner_handle: "alice-a3b4",
	},
];

describe("project member lifecycle commands", () => {
	it("lists and removes accepted members with JSON output", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/projects/project-owned/members",
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
				path: "/v1/projects/project-owned/members/user-bob",
				response: () => jsonResponse({ status: "removed" }),
			},
			{ method: "GET", path: "/v1/projects", response: () => jsonResponse(projects) },
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await projectMembersCommand("engineering", { remove: "bob@example.test", json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /v1/projects",
			"GET /v1/projects/project-owned/members",
			"DELETE /v1/projects/project-owned/members/user-bob",
		]);
		expect(JSON.parse(out)).toEqual({
			project_id: "project-owned",
			removed_user_id: "user-bob",
			status: "removed",
		});
	});

	it("leaves a shared project", async () => {
		const { restore } = mockFetch([
			{ method: "GET", path: "/v1/projects", response: () => jsonResponse(projects) },
			{
				method: "POST",
				path: "/v1/projects/project-shared/leave",
				response: () => jsonResponse({ status: "left" }),
			},
		]);
		const orig = console.log;
		let out = "";
		console.log = (...args: unknown[]) => {
			out = args.map(String).join(" ");
		};
		try {
			await projectLeaveCommand("@alice-a3b4/shared-toolkit", { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(JSON.parse(out)).toEqual({
			project_id: "project-shared",
			status: "left",
		});
	});

	it("unshares an owned project", async () => {
		const { restore } = mockFetch([
			{ method: "GET", path: "/v1/projects", response: () => jsonResponse(projects) },
			{
				method: "POST",
				path: "/v1/projects/project-owned/unshare",
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
			await projectUnshareCommand("engineering", { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		expect(JSON.parse(out)).toEqual({
			project_id: "project-owned",
			links_revoked: 1,
			members_removed: 2,
			invitations_cancelled: 3,
		});
	});
});
