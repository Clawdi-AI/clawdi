import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allAdapterEntries } from "../../src/adapters/registry";
import {
	inboxAcceptCommand,
	inboxForgetCommand,
	inboxJoinCommand,
	inboxListCommand,
} from "../../src/commands/inbox";
import { addToken, findToken, listTokens } from "../../src/share/tokens";
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

function addPendingShare(
	overrides: Partial<Parameters<typeof addToken>[0]> = {},
): Parameters<typeof addToken>[0] {
	const token = {
		project_id: "project-shared",
		project_name: "Shared Toolkit",
		owner_display: "Alice",
		owner_handle: "alice-a3b4",
		token: rawToken,
		redeemed_at: "2026-05-18T00:00:00.000Z",
		api_origin: "https://api.test",
		...overrides,
	};
	addToken(token);
	return token;
}

function upgradeResponse(projectId = "project-shared") {
	return {
		membership_id: "membership-1",
		project_id: projectId,
		role: "viewer",
		joined_via: "link",
		joined_at: "2026-05-14T00:00:00Z",
		resolved_owner_handle: "alice-a3b4",
		bound_agent_ids: [],
	};
}

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origAuthToken = process.env.CLAWDI_AUTH_TOKEN;
	origApiUrl = process.env.CLAWDI_API_URL;
	agentHomeOverrides = snapshotAndClearAgentHomeOverrides();
	tmpHome = join(tmpdir(), `clawdi-inbox-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(
		join(tmpHome, ".clawdi", "auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			endpointBinding: { version: 1, cloudApiOrigin: "https://api.test" },
		}),
	);
	process.env.HOME = tmpHome;
	delete process.env.CLAWDI_HOME;
	delete process.env.CLAWDI_AUTH_TOKEN;
	process.env.CLAWDI_API_URL = "https://api.test";
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

	it("stages a signed-out share without changing membership and prints exact next commands", async () => {
		rmSync(join(tmpHome, ".clawdi", "auth.json"), { force: true });
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: `/v1/share/${rawToken}/redeem`,
				response: () =>
					jsonResponse({
						project_id: "project-shared",
						project_name: "Shared Toolkit",
						owner_display: "Alice",
						owner_handle: "alice-a3b4",
						skill_count: 2,
						vault_count: 1,
						vault_locked: true,
					}),
			},
		]);
		const originalLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		try {
			await inboxAcceptCommand(`https://clawdi.ai/share/${rawToken}`, {});
		} finally {
			console.log = originalLog;
			restore();
		}

		const output = lines.join("\n");
		expect(output).toContain("No account or project membership was changed.");
		expect(output).toContain("Next: clawdi auth login");
		expect(output).toContain("Then: clawdi inbox join project-shared");
		expect(output).not.toContain(rawToken);
		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			`POST /v1/share/${rawToken}/redeem`,
		]);
		expect(findToken("project-shared")).toBeDefined();
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
		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			"POST /v1/me/invitations/invite-attached/accept",
		]);
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

	it("prints explicit next steps without downloading when accepting project access", async () => {
		addPendingShare({ project_id: "uuid-project-shared" });
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
						bound_agent_ids: [],
					}),
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
		expect(out).toContain("Joined project uuid-project-shared.");
		expect(out).toContain("Role: viewer (read access).");
		expect(out).toContain(
			"Attach to Agent: clawdi agent projects attach <agent-id> --project uuid-project-shared",
		);
		expect(out).toContain("Next (optional): clawdi pull --project uuid-project-shared");
		expect(out).not.toContain(rawToken);
		expect(out).not.toMatch(/\bbind(ing|s)?\b/i);
		expect(captured[0].headers["idempotency-key"]).toMatch(/^upgrade-[a-f0-9]{32}$/);
		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			`POST /v1/share/${rawToken}/upgrade`,
		]);
		expect(findToken("uuid-project-shared")).toBeUndefined();
	});
});

describe("explicit local share join", () => {
	it("shows local pending shares in the signed-in inbox without exposing tokens", async () => {
		addPendingShare();
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/me/invitations",
				response: () => jsonResponse([]),
			},
		]);
		const originalLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		try {
			await inboxListCommand({});
		} finally {
			console.log = originalLog;
			restore();
		}

		const output = lines.join("\n");
		expect(output).toContain("Local pending project shares (1)");
		expect(output).toContain("Join: clawdi inbox join project-shared");
		expect(output).not.toContain(rawToken);
		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /v1/me/invitations",
		]);
	});

	it("joins exactly one staged project, clears its token, and only suggests pulling", async () => {
		addPendingShare();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: `/v1/share/${rawToken}/upgrade`,
				response: () => jsonResponse(upgradeResponse()),
			},
		]);
		const originalLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
		try {
			await inboxJoinCommand("project-shared", {});
		} finally {
			console.log = originalLog;
			restore();
		}

		const output = lines.join("\n");
		expect(output).toContain("Joined project project-shared.");
		expect(output).toContain("Next (optional): clawdi pull --project project-shared");
		expect(output).not.toContain(rawToken);
		expect(listTokens()).toEqual([]);
		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			`POST /v1/share/${rawToken}/upgrade`,
		]);
		expect(captured[0].headers["idempotency-key"]).toMatch(/^upgrade-[a-f0-9]{32}$/);
	});

	it("clears terminal local tickets with a clear outcome", async () => {
		for (const terminal of [
			{
				status: 409,
				body: { detail: { error: "already_owner" } },
				expected: /access already exists/i,
			},
			{ status: 404, body: { detail: "not found" }, expected: /share is unavailable/i },
			{ status: 410, body: { detail: "gone" }, expected: /share is unavailable/i },
		]) {
			addPendingShare();
			const { restore } = mockFetch([
				{
					method: "POST",
					path: `/v1/share/${rawToken}/upgrade`,
					response: () => jsonResponse(terminal.body, terminal.status),
				},
			]);
			const originalLog = console.log;
			const lines: string[] = [];
			console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
			try {
				await inboxJoinCommand("project-shared", {});
			} finally {
				console.log = originalLog;
				restore();
			}
			expect(lines.join("\n")).toMatch(terminal.expected);
			expect(lines.join("\n")).not.toContain(rawToken);
			expect(listTokens()).toEqual([]);
		}
	});

	it("preserves the local ticket on transient, conflict, and malformed responses", async () => {
		for (const transient of [
			{
				response: () => jsonResponse({ detail: "temporary" }, 503),
				expected: /temporarily unavailable/i,
			},
			{
				response: () => jsonResponse({ project_id: "project-shared" }),
				expected: /invalid project join response/i,
			},
			{
				response: () => jsonResponse({ detail: { error: "other_conflict" } }, 409),
				expected: /access state changed/i,
			},
			{
				response: () => {
					throw new TypeError("private network detail");
				},
				expected: /Could not reach Clawdi/i,
			},
		]) {
			addPendingShare();
			const { restore } = mockFetch([
				{
					method: "POST",
					path: `/v1/share/${rawToken}/upgrade`,
					response: transient.response,
				},
			]);
			try {
				let error: Error | undefined;
				try {
					await inboxJoinCommand("project-shared", {});
				} catch (caught) {
					error = caught instanceof Error ? caught : new Error(String(caught));
				}
				expect(error?.message).toMatch(transient.expected);
				expect(error?.message).not.toContain(rawToken);
				expect(findToken("project-shared")?.token).toBe(rawToken);
			} finally {
				restore();
			}
		}
	});

	it("rejects an origin mismatch before any request or mutation", async () => {
		addPendingShare({ api_origin: "https://other-api.test" });
		const { captured, restore } = mockFetch([]);
		const originalError = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
		try {
			await inboxJoinCommand("project-shared", {});
		} finally {
			console.error = originalError;
			restore();
		}

		expect(process.exitCode).toBe(1);
		expect(errors.join("\n")).toContain("Switch to the matching API and retry");
		expect(errors.join("\n")).not.toContain(rawToken);
		expect(captured).toEqual([]);
		expect(findToken("project-shared")?.token).toBe(rawToken);
	});

	it("does not delete a replacement ticket created while a join is in flight", async () => {
		addPendingShare();
		const replacementToken = "b".repeat(43);
		const { restore } = mockFetch([
			{
				method: "POST",
				path: `/v1/share/${rawToken}/upgrade`,
				response: () => {
					addPendingShare({ token: replacementToken });
					return jsonResponse(upgradeResponse());
				},
			},
		]);
		const originalLog = console.log;
		console.log = () => {};
		try {
			await inboxJoinCommand("project-shared", {});
		} finally {
			console.log = originalLog;
			restore();
		}

		expect(findToken("project-shared")?.token).toBe(replacementToken);
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
