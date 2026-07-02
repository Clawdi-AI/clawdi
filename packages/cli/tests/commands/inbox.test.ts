import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allAdapterEntries } from "../../src/adapters/registry";
import { inboxAcceptCommand, inboxForgetCommand } from "../../src/commands/inbox";
import { addToken, findToken } from "../../src/share/tokens";
import {
	type AgentHomeOverrideSnapshot,
	jsonResponse,
	mockFetch,
	restoreAgentHomeOverrides,
	snapshotAndClearAgentHomeOverrides,
} from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origAuthToken: string | undefined;
let origApiUrl: string | undefined;
let agentHomeOverrides: AgentHomeOverrideSnapshot;

const rawToken = "a".repeat(43);

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origAuthToken = process.env.CLAWDI_AUTH_TOKEN;
	origApiUrl = process.env.CLAWDI_API_URL;
	agentHomeOverrides = snapshotAndClearAgentHomeOverrides();
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
	restoreAgentHomeOverrides(agentHomeOverrides);
	rmSync(tmpHome, { recursive: true, force: true });
	process.exitCode = 0;
});

describe("inboxAcceptCommand", () => {
	it("rejects signed-out --agent before redeeming a share URL", async () => {
		rmSync(join(tmpHome, ".clawdi", "auth.json"), { force: true });
		const orig = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			await inboxAcceptCommand(`https://clawdi.ai/share/${rawToken}`, {
				agent: ["agent-1"],
			});
		} finally {
			console.error = orig;
		}

		const exitCode = process.exitCode;
		process.exitCode = 0;
		expect(exitCode).toBe(1);
		expect(errors.join("\n")).toContain("Sign in before attaching an accepted Project to an Agent");
	});

	it("rejects attachment mode without --agent before posting", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/me/invitations/invite-mode/accept",
				response: () => jsonResponse({}),
			},
		]);
		try {
			await expect(
				inboxAcceptCommand(undefined, {
					invite: "invite-mode",
					useAs: "attached",
				}),
			).rejects.toThrow(/Pass --agent/);
		} finally {
			restore();
		}

		expect(captured).toEqual([]);
	});

	it("sends --use-as attached using project language", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/me/invitations/invite-attached/accept",
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
				path: "/v1/skills",
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
			use_as: "attached",
		});
	});

	it("rejects --use-as home before posting", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/v1/me/invitations/invite-home/accept",
				response: () => jsonResponse({}),
			},
		]);
		try {
			await expect(
				inboxAcceptCommand(undefined, {
					invite: "invite-home",
					agent: ["agent-1"],
					useAs: "home",
				}),
			).rejects.toThrow(/fixed/);
		} finally {
			restore();
		}

		expect(captured).toEqual([]);
	});

	it("prints exact Attach to Agent command when accepting project access", async () => {
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: `/v1/share/${rawToken}/upgrade`,
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
				path: "/v1/skills",
				response: () => jsonResponse({ items: [] }),
			},
			{
				method: "GET",
				path: "/v1/projects",
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
		expect(out).toContain("Role: viewer (read access).");
		expect(out).toContain(
			"Attach to Agent: clawdi agent projects attach <agent-id> --project @alice-a3b4/shared-toolkit",
		);
		expect(out).not.toMatch(/\bbind(ing|s)?\b/i);
		expect(captured[0].headers["idempotency-key"]).toMatch(/^upgrade-[a-f0-9]{32}$/);
	});
});

describe("inboxForgetCommand", () => {
	it("keeps local shared skill folders still referenced by another project from the same owner", () => {
		addToken({
			project_id: "project-a",
			project_name: "A",
			owner_display: "Alice",
			owner_handle: "alice-a3b4",
			token: "a".repeat(43),
			redeemed_at: "2026-05-18T00:00:00.000Z",
			last_seen_skill_keys: ["deploy-tools"],
		});
		addToken({
			project_id: "project-b",
			project_name: "B",
			owner_display: "Alice",
			owner_handle: "alice-a3b4",
			token: "b".repeat(43),
			redeemed_at: "2026-05-18T00:00:00.000Z",
			last_seen_skill_keys: ["deploy-tools"],
		});

		const dirs = allAdapterEntries().map((entry) =>
			entry.create().getSharedSkillPath("deploy-tools", "alice-a3b4"),
		);
		for (const dir of dirs) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), "shared");
		}
		const origLog = console.log;
		console.log = () => {};
		try {
			inboxForgetCommand("project-a");
		} finally {
			console.log = origLog;
		}

		expect(findToken("project-a")).toBeUndefined();
		expect(findToken("project-b")).toBeDefined();
		for (const dir of dirs) expect(existsSync(dir)).toBe(true);
	});
});
