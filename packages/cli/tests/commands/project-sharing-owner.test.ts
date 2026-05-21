import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectInviteCommand } from "../../src/commands/project-invite";
import { projectInvitesCommand } from "../../src/commands/project-invites";
import { projectShareCommand } from "../../src/commands/project-share";
import { projectShareLinksCommand } from "../../src/commands/project-share-links";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

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

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(
		tmpdir(),
		`clawdi-project-sharing-owner-${Date.now()}-${Math.random().toString(36)}`,
	);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://api.test";
	process.exitCode = 0;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpHome, { recursive: true, force: true });
	process.exitCode = 0;
});

function captureConsole(): {
	lines: string[];
	errors: string[];
	restore: () => void;
} {
	const origLog = console.log;
	const origError = console.error;
	const lines: string[] = [];
	const errors: string[] = [];
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	};
	return {
		lines,
		errors,
		restore: () => {
			console.log = origLog;
			console.error = origError;
		},
	};
}

describe("owner project sharing commands", () => {
	it("creates a read-only share link for the resolved project", async () => {
		const { captured, restore } = mockFetch([
			{ method: "GET", path: /^\/api\/projects$/, response: () => jsonResponse(projects) },
			{
				method: "POST",
				path: "/api/projects/project-owned/share-links",
				response: () =>
					jsonResponse(
						{
							id: "link-1",
							raw_token: "tok_raw_secret",
							url: "https://clawdi.test/share/tok_raw_secret",
							prefix: "tok_raw",
							owner_handle: "owner-1234",
							label: "client review",
							created_at: "2026-05-15T10:00:00Z",
							expires_at: null,
						},
						201,
					),
			},
		]);
		const consoleCapture = captureConsole();
		try {
			await projectShareCommand("engineering", { label: "client review" });
		} finally {
			consoleCapture.restore();
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/projects",
			"GET /api/projects",
			"POST /api/projects/project-owned/share-links",
		]);
		expect(captured[2].body).toEqual({ label: "client review" });
		const out = consoleCapture.lines.join("\n");
		expect(out).toContain("Viewer project link ready");
		expect(out).toContain("Viewers can resolve shared Vault values through CLI runtime reads.");
		expect(out).toContain("https://clawdi.test/share/tok_raw_secret");
		expect(out).toContain("clawdi inbox accept https://clawdi.test/share/tok_raw_secret");
		expect(out).toContain(
			"clawdi agent projects attach <agent-id> --project @owner-1234/engineering",
		);
		expect(out).not.toMatch(/\bbind(ing|s)?\b/i);
	});

	it("revokes a share link by unique prefix", async () => {
		const { captured, restore } = mockFetch([
			{ method: "GET", path: /^\/api\/projects$/, response: () => jsonResponse(projects) },
			{
				method: "GET",
				path: "/api/projects/project-owned/share-links",
				response: () =>
					jsonResponse([
						{
							id: "link-aaaaaaaa",
							prefix: "abc123",
							label: null,
							created_at: "2026-05-15T10:00:00Z",
							expires_at: null,
							revoked_at: null,
							redeem_count: 1,
							last_redeemed_at: "2026-05-15T11:00:00Z",
						},
						{
							id: "link-bbbbbbbb",
							prefix: "xyz987",
							label: "partner",
							created_at: "2026-05-15T12:00:00Z",
							expires_at: null,
							revoked_at: null,
							redeem_count: 0,
							last_redeemed_at: null,
						},
					]),
			},
			{
				method: "DELETE",
				path: "/api/projects/project-owned/share-links/link-aaaaaaaa",
				response: () => jsonResponse({ status: "revoked" }),
			},
		]);
		const consoleCapture = captureConsole();
		try {
			await projectShareLinksCommand("engineering", { revoke: "abc" });
		} finally {
			consoleCapture.restore();
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/projects",
			"GET /api/projects/project-owned/share-links",
			"DELETE /api/projects/project-owned/share-links/link-aaaaaaaa",
		]);
		expect(consoleCapture.lines.join("\n")).toContain("Share link revoked");
	});

	it("lists share links without exposing raw tokens", async () => {
		const { captured, restore } = mockFetch([
			{ method: "GET", path: /^\/api\/projects$/, response: () => jsonResponse(projects) },
			{
				method: "GET",
				path: "/api/projects/project-owned/share-links",
				response: () =>
					jsonResponse([
						{
							id: "link-aaaaaaaa",
							prefix: "abc123",
							label: "client",
							created_at: "2026-05-15T10:00:00Z",
							expires_at: null,
							revoked_at: null,
							redeem_count: 2,
							last_redeemed_at: "2026-05-15T11:00:00Z",
						},
						{
							id: "link-bbbbbbbb",
							prefix: "xyz987",
							label: null,
							created_at: "2026-05-15T12:00:00Z",
							expires_at: null,
							revoked_at: "2026-05-15T13:00:00Z",
							redeem_count: 0,
							last_redeemed_at: null,
						},
					]),
			},
		]);
		const consoleCapture = captureConsole();
		try {
			await projectShareLinksCommand("engineering", {});
		} finally {
			consoleCapture.restore();
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/projects",
			"GET /api/projects/project-owned/share-links",
		]);
		const out = consoleCapture.lines.join("\n");
		expect(out).toContain("Project share links (2)");
		expect(out).toContain("abc123");
		expect(out).toContain("xyz987");
		expect(out).toContain("client");
		expect(out).toContain("2 accepts");
		expect(out).toContain("revoked");
		expect(out).toContain("clawdi project share-links engineering --revoke <prefix>");
		expect(out).not.toContain("tok_raw_secret");
	});

	it("rejects an ambiguous share link prefix before deleting", async () => {
		const { captured, restore } = mockFetch([
			{ method: "GET", path: /^\/api\/projects$/, response: () => jsonResponse(projects) },
			{
				method: "GET",
				path: "/api/projects/project-owned/share-links",
				response: () =>
					jsonResponse([
						{
							id: "link-1",
							prefix: "abc123",
							label: null,
							created_at: "2026-05-15T10:00:00Z",
							expires_at: null,
							revoked_at: null,
							redeem_count: 0,
							last_redeemed_at: null,
						},
						{
							id: "link-2",
							prefix: "abc999",
							label: null,
							created_at: "2026-05-15T10:00:00Z",
							expires_at: null,
							revoked_at: null,
							redeem_count: 0,
							last_redeemed_at: null,
						},
					]),
			},
		]);
		const consoleCapture = captureConsole();
		try {
			await projectShareLinksCommand("engineering", { revoke: "abc" });
		} finally {
			consoleCapture.restore();
			restore();
		}

		const exitCode = process.exitCode;
		process.exitCode = 0;
		expect(exitCode).toBe(1);
		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/projects",
			"GET /api/projects/project-owned/share-links",
		]);
		expect(consoleCapture.errors.join("\n")).toContain("matches 2 links");
	});

	it("sends an invitation to an existing user", async () => {
		const { captured, restore } = mockFetch([
			{ method: "GET", path: /^\/api\/projects$/, response: () => jsonResponse(projects) },
			{
				method: "POST",
				path: "/api/projects/project-owned/invitations",
				response: () =>
					jsonResponse(
						{
							id: "invite-1",
							project_id: "project-owned",
							project_name: "Engineering",
							invitee_email: "bob@example.test",
							owner_handle: "owner-1234",
							created_at: "2026-05-15T10:00:00Z",
						},
						201,
					),
			},
		]);
		const consoleCapture = captureConsole();
		try {
			await projectInviteCommand("engineering", { email: "bob@example.test" });
		} finally {
			consoleCapture.restore();
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/projects",
			"POST /api/projects/project-owned/invitations",
		]);
		expect(captured[1].body).toEqual({ email: "bob@example.test" });
		const out = consoleCapture.lines.join("\n");
		expect(out).toContain("Invitation sent to bob@example.test");
		expect(out).toContain("viewer with read access");
		expect(out).toContain("clawdi agent projects attach <agent-id> --project <project>");
	});

	it("suggests a share link when invite email has no account", async () => {
		const { captured, restore } = mockFetch([
			{ method: "GET", path: /^\/api\/projects$/, response: () => jsonResponse(projects) },
			{
				method: "POST",
				path: "/api/projects/project-owned/invitations",
				response: () =>
					jsonResponse(
						{
							detail: {
								error: "user_not_found",
								message: "No user found for email",
							},
						},
						404,
					),
			},
		]);
		const consoleCapture = captureConsole();
		try {
			await projectInviteCommand("engineering", { email: "new-user@example.test" });
		} finally {
			consoleCapture.restore();
			restore();
		}

		const exitCode = process.exitCode;
		process.exitCode = 0;
		expect(exitCode).toBe(1);
		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/projects",
			"POST /api/projects/project-owned/invitations",
		]);
		const err = consoleCapture.errors.join("\n");
		expect(err).toContain("No clawdi account found");
		expect(err).toContain("clawdi project share engineering");
	});

	it("lists pending invitations for an owned project", async () => {
		const { captured, restore } = mockFetch([
			{ method: "GET", path: /^\/api\/projects$/, response: () => jsonResponse(projects) },
			{
				method: "GET",
				path: "/api/projects/project-owned/invitations",
				response: () =>
					jsonResponse([
						{
							id: "invite-12345678",
							project_id: "project-owned",
							project_name: "Engineering",
							project_kind: "workspace",
							owner_display: "Owner",
							owner_handle: "owner-1234",
							invitee_email: "bob@example.test",
							invited_by_user_id: "owner-user",
							invited_by_display: "Owner",
							created_at: "2026-05-15T10:00:00Z",
						},
					]),
			},
		]);
		const consoleCapture = captureConsole();
		try {
			await projectInvitesCommand("engineering", {});
		} finally {
			consoleCapture.restore();
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/projects",
			"GET /api/projects/project-owned/invitations",
		]);
		const out = consoleCapture.lines.join("\n");
		expect(out).toContain("Pending project invites (1)");
		expect(out).toContain("bob@example.test");
		expect(out).toContain("clawdi project invites engineering --cancel <id>");
	});

	it("cancels a pending invitation", async () => {
		const { captured, restore } = mockFetch([
			{ method: "GET", path: /^\/api\/projects$/, response: () => jsonResponse(projects) },
			{
				method: "DELETE",
				path: "/api/projects/project-owned/invitations/invite-1",
				response: () => jsonResponse({ status: "cancelled" }),
			},
		]);
		const consoleCapture = captureConsole();
		try {
			await projectInvitesCommand("engineering", { cancel: "invite-1" });
		} finally {
			consoleCapture.restore();
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /api/projects",
			"DELETE /api/projects/project-owned/invitations/invite-1",
		]);
		expect(consoleCapture.lines.join("\n")).toContain("Invitation cancelled");
	});
});
