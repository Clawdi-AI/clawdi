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

	it("stages signed-out access and lists the redacted ticket after sign-in", async () => {
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
			restore();
		}
		writeFileSync(
			join(tmpHome, ".clawdi", "auth.json"),
			JSON.stringify({
				apiKey: "test-key",
				endpointBinding: { version: 1, cloudApiOrigin: "https://api.test" },
			}),
		);
		const inboxFetch = mockFetch([
			{
				method: "GET",
				path: "/v1/me/invitations",
				response: () => jsonResponse([]),
			},
		]);
		try {
			await inboxListCommand({});
		} finally {
			console.log = originalLog;
			inboxFetch.restore();
		}

		const output = lines.join("\n");
		expect(output).toContain("No account or project membership was changed.");
		expect(output).toContain("Next: clawdi auth login");
		expect(output).toContain("Then: clawdi inbox join project-shared");
		expect(output).toContain("Join: clawdi inbox join project-shared");
		expect(output).not.toContain(rawToken);
		expect(captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			`POST /v1/share/${rawToken}/redeem`,
		]);
		expect(inboxFetch.captured.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /v1/me/invitations",
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

	it("explicitly joins one staged project without pulling content", async () => {
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
			await inboxJoinCommand("uuid-project-shared", {});
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

describe("share ticket outcomes", () => {
	it("deletes only terminal tickets and rejects origin mismatches before join or accept", async () => {
		type Case = {
			command?: "join" | "accept";
			apiOrigin?: string;
			response?: () => Response;
			deletes: boolean;
			makesRequest?: boolean;
			expected: RegExp;
		};
		const cases: Case[] = [
			{
				response: () => jsonResponse({ detail: { error: "already_owner" } }, 409),
				deletes: true,
				expected: /access already exists/i,
			},
			...([404, 410] as const).map((status) => ({
				response: () => jsonResponse({ detail: "unavailable" }, status),
				deletes: true,
				expected: /share is unavailable/i,
			})),
			{
				response: () => jsonResponse({ detail: "temporary" }, 503),
				deletes: false,
				expected: /temporarily unavailable/i,
			},
			{
				response: () => jsonResponse({ project_id: "project-shared" }),
				deletes: false,
				expected: /invalid project join response/i,
			},
			{
				response: () => jsonResponse({ detail: { error: "other_conflict" } }, 409),
				deletes: false,
				expected: /access state changed/i,
			},
			{
				response: () => {
					throw new TypeError("private network detail");
				},
				deletes: false,
				expected: /Could not reach Clawdi/i,
			},
			{
				apiOrigin: "https://other-api.test",
				deletes: false,
				makesRequest: false,
				expected: /matching API/i,
			},
			{
				command: "accept",
				apiOrigin: "https://other-api.test",
				deletes: false,
				makesRequest: false,
				expected: /matching API/i,
			},
		];

		for (const testCase of cases) {
			addPendingShare({ api_origin: testCase.apiOrigin ?? "https://api.test" });
			const { captured, restore } = mockFetch([
				{
					method: "POST",
					path: `/v1/share/${rawToken}/upgrade`,
					response: testCase.response ?? (() => jsonResponse({})),
				},
			]);
			const originalLog = console.log;
			const originalError = console.error;
			const lines: string[] = [];
			console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
			console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
			let caught: Error | undefined;
			try {
				if (testCase.command === "accept") {
					await inboxAcceptCommand(`https://clawdi.ai/share/${rawToken}`, {});
				} else {
					await inboxJoinCommand("project-shared", {});
				}
			} catch (error) {
				caught = error instanceof Error ? error : new Error(String(error));
			} finally {
				console.log = originalLog;
				console.error = originalError;
				restore();
			}

			const output = [caught?.message, ...lines].filter(Boolean).join("\n");
			expect(output).toMatch(testCase.expected);
			expect(output).not.toContain(rawToken);
			expect(captured).toHaveLength(testCase.makesRequest === false ? 0 : 1);
			expect(findToken("project-shared") === undefined).toBe(testCase.deletes);
			process.exitCode = 0;
		}
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
