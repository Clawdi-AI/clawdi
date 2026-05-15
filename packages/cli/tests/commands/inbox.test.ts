import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inboxAcceptCommand } from "../../src/commands/inbox";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origAuthToken: string | undefined;
let origApiUrl: string | undefined;

const rawToken = "a".repeat(43);

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origAuthToken = process.env.CLAWDI_AUTH_TOKEN;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-inbox-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	delete process.env.CLAWDI_HOME;
	delete process.env.CLAWDI_AUTH_TOKEN;
	process.env.CLAWDI_API_URL = "http://api.test";
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origClawdiHome) process.env.CLAWDI_HOME = origClawdiHome;
	else delete process.env.CLAWDI_HOME;
	if (origAuthToken) process.env.CLAWDI_AUTH_TOKEN = origAuthToken;
	else delete process.env.CLAWDI_AUTH_TOKEN;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpHome, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe("inboxAcceptCommand", () => {
	it("maps --use-as attached to backend bind_as=context", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/me/invitations/invite-attached/accept",
				response: () =>
					jsonResponse({
						id: "membership-attached",
						project_id: "uuid-project-shared",
						role: "viewer",
						joined_via: "invitation",
						joined_at: "2026-05-14T00:00:00Z",
						resolved_owner_handle: "alice-a3b4",
						bound_agent_ids: ["agent-1"],
					}),
			},
			{
				method: "GET",
				path: "/api/skills",
				response: () => jsonResponse({ items: [] }),
			},
		]);
		const orig = console.log;
		console.log = () => {};
		try {
			await inboxAcceptCommand(undefined, {
				invite: "invite-attached",
				agent: ["agent-1"],
				useAs: "attached",
				json: true,
			});
		} finally {
			console.log = orig;
			restore();
		}

		expect(captured[0].body).toEqual({
			agent_ids: ["agent-1"],
			bind_as: "context",
		});
	});

	it("maps --use-as home to backend bind_as=primary and prints Home Project wording", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/me/invitations/invite-home/accept",
				response: () =>
					jsonResponse({
						id: "membership-home",
						project_id: "uuid-project-shared",
						role: "viewer",
						joined_via: "invitation",
						joined_at: "2026-05-14T00:00:00Z",
						resolved_owner_handle: "alice-a3b4",
						bound_agent_ids: ["agent-1"],
					}),
			},
			{
				method: "GET",
				path: "/api/skills",
				response: () => jsonResponse({ items: [] }),
			},
			{
				method: "GET",
				path: "/api/projects",
				response: () =>
					jsonResponse([
						{
							id: "uuid-project-shared",
							slug: "shared-toolkit",
							name: "Shared Toolkit",
							kind: "workspace",
							is_owner: false,
							owner_handle: "alice-a3b4",
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
			await inboxAcceptCommand(undefined, {
				invite: "invite-home",
				agent: ["agent-1"],
				useAs: "home",
			});
		} finally {
			console.log = orig;
			restore();
		}

		expect(captured[0].body).toEqual({
			agent_ids: ["agent-1"],
			bind_as: "primary",
		});
		const out = lines.join("\n");
		expect(out).toContain("Attached to 1 agent as Home Project.");
		expect(out).not.toMatch(/\b(primary|context)\b/i);
	});

	it("keeps deprecated --bind-as compatibility for primary/context payloads", async () => {
		for (const [bindAs, expected] of [
			["primary", "primary"],
			["context", "context"],
		] as const) {
			const inviteId = `invite-${bindAs}`;
			const { captured, restore } = mockFetch([
				{
					method: "POST",
					path: `/api/me/invitations/${inviteId}/accept`,
					response: () =>
						jsonResponse({
							id: `membership-${bindAs}`,
							project_id: "uuid-project-shared",
							role: "viewer",
							joined_via: "invitation",
							joined_at: "2026-05-14T00:00:00Z",
							resolved_owner_handle: "alice-a3b4",
							bound_agent_ids: ["agent-1"],
						}),
				},
				{
					method: "GET",
					path: "/api/skills",
					response: () => jsonResponse({ items: [] }),
				},
			]);
			const orig = console.log;
			console.log = () => {};
			try {
				await inboxAcceptCommand(undefined, {
					invite: inviteId,
					agent: ["agent-1"],
					bindAs,
					json: true,
				});
			} finally {
				console.log = orig;
				restore();
			}

			expect(captured[0].body).toEqual({
				agent_ids: ["agent-1"],
				bind_as: expected,
			});
		}
	});

	it("prints exact use-with-agent command when accepting project access", async () => {
		const { restore } = mockFetch([
			{
				method: "POST",
				path: `/api/share/${rawToken}/upgrade`,
				response: () =>
					jsonResponse({
						membership_id: "membership-1",
						project_id: "uuid-project-shared",
						role: "viewer",
						joined_via: "link",
						joined_at: "2026-05-14T00:00:00Z",
						resolved_owner_handle: "alice-a3b4",
					}),
			},
			{
				method: "GET",
				path: "/api/skills",
				response: () => jsonResponse({ items: [] }),
			},
			{
				method: "GET",
				path: "/api/projects",
				response: () =>
					jsonResponse([
						{
							id: "uuid-project-shared",
							slug: "shared-toolkit",
							name: "Shared Toolkit",
							kind: "workspace",
							is_owner: false,
							owner_handle: "alice-a3b4",
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
			await inboxAcceptCommand(`https://clawdi.ai/share/${rawToken}`, {});
		} finally {
			console.log = orig;
			restore();
		}

		const out = lines.join("\n");
		expect(out).toContain("Accepted project access for @alice-a3b4/shared-toolkit.");
		expect(out).toContain("Role: viewer (read-only).");
		expect(out).toContain(
			"Use with agent: clawdi agent projects attach <agent-id> --project @alice-a3b4/shared-toolkit",
		);
		expect(out).not.toMatch(/\bbind(ing|s)?\b/i);
	});
});
