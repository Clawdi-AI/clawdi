import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
let origPath: string | undefined;

const rawToken = "a".repeat(43);

async function addPendingShare(
	overrides: Partial<Parameters<typeof addToken>[0]> = {},
): Promise<Parameters<typeof addToken>[0]> {
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
	await addToken(token);
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
	origPath = process.env.PATH;
	const bin = join(tmpHome, "bin");
	mkdirSync(bin, { recursive: true });
	const command = join(bin, "openclaw");
	writeFileSync(
		command,
		`#!/bin/sh
if [ "$*" = "agents list --json" ]; then printf '[{"id":"main","workspace":"%s/.openclaw/agents/main"}]\n' "$HOME"; exit 0; fi
exit 1
`,
	);
	chmodSync(command, 0o755);
	process.env.PATH = `${bin}:${origPath ?? ""}`;
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
	if (origPath !== undefined) process.env.PATH = origPath;
	else delete process.env.PATH;
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
		expect(errors.join("\n")).toContain("Sign in before linking an accepted Project to an Agent");
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
		const staged = findToken("project-shared");
		expect(staged).toBeDefined();
		if (!staged) throw new Error("Expected staged share fixture");
		await addToken({ ...staged, upgraded_at: "2026-05-19T00:00:00.000Z" });
		rmSync(join(tmpHome, ".clawdi", "auth.json"), { force: true });
		const legacyFetch = mockFetch([]);
		const legacyLines: string[] = [];
		console.log = (...args: unknown[]) => legacyLines.push(args.map(String).join(" "));
		try {
			await inboxAcceptCommand(`https://clawdi.ai/share/${rawToken}`, {});
			await inboxListCommand({});
			await inboxAcceptCommand(`https://clawdi.ai/share/${rawToken}`, { json: true });
			await inboxListCommand({ json: true });
		} finally {
			console.log = originalLog;
			legacyFetch.restore();
		}
		const legacyOutput = legacyLines.join("\n");
		expect(legacyOutput).toContain("was handled by an older Clawdi CLI");
		expect(legacyOutput).toContain("No account or project membership was changed now.");
		expect(legacyOutput).toContain("clawdi project list --shared-with-me");
		expect(legacyOutput).toContain("Old local share records — cleanup only (1)");
		expect(legacyOutput).toContain("No automatic action occurs for these records.");
		expect(legacyOutput).toContain('"status": "legacy_local_share_record"');
		expect(legacyOutput).toContain('"legacy_local_share_records": [');
		expect(legacyOutput).toContain('"cleanup_command": "clawdi inbox forget project-shared"');
		expect(legacyOutput).not.toContain("clawdi inbox join");
		expect(legacyOutput).not.toContain(rawToken);
		expect(legacyFetch.captured).toEqual([]);
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

	it("joins staged projects without pulling content and discloses ticket removal", async () => {
		await addPendingShare({ project_id: "uuid-project-shared" });
		const jsonJoinToken = "b".repeat(43);
		const acceptToken = "c".repeat(43);
		await addPendingShare({ project_id: "uuid-project-json", token: jsonJoinToken });
		await addPendingShare({ project_id: "uuid-project-accept", token: acceptToken });
		const joinedResponse = (projectId: string) =>
			jsonResponse({
				membership_id: `membership-${projectId}`,
				project_id: projectId,
				role: "viewer",
				joined_via: "link",
				joined_at: "2026-05-14T00:00:00Z",
				resolved_owner_handle: "alice-a3b4",
				bound_agent_ids: [],
			});
		const shareProjects = [
			[rawToken, "uuid-project-shared"],
			[jsonJoinToken, "uuid-project-json"],
			[acceptToken, "uuid-project-accept"],
		] as const;
		const { captured, restore } = mockFetch(
			shareProjects.map(([token, projectId]) => ({
				method: "POST",
				path: `/v1/share/${token}/upgrade`,
				response: () => joinedResponse(projectId),
			})),
		);
		const orig = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			await inboxJoinCommand("uuid-project-shared", {});
			await inboxJoinCommand("uuid-project-json", { json: true });
			await inboxAcceptCommand(`https://clawdi.ai/share/${acceptToken}`, { json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const out = lines.join("\n");
		expect(out).toContain("Joined project uuid-project-shared.");
		expect(out).toContain("Local share ticket removed from this device.");
		expect(out).toContain("Role: viewer (read access).");
		expect(out).toContain(
			"Link to Agent: clawdi agent projects link <agent-id> --project uuid-project-shared",
		);
		expect(out).toContain("Next (optional): clawdi pull --project uuid-project-shared");
		expect(out).not.toContain(rawToken);
		expect(captured[0].headers["idempotency-key"]).toMatch(/^upgrade-[a-f0-9]{32}$/);
		const jsonOutput: Array<Record<string, unknown>> = lines
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line));
		expect(jsonOutput.map((payload) => payload.local_ticket_removed)).toEqual([true, true]);
		expect(captured).toHaveLength(3);
		expect(findToken("uuid-project-shared")).toBeUndefined();
		expect(findToken("uuid-project-json")).toBeUndefined();
		expect(findToken("uuid-project-accept")).toBeUndefined();
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
			await addPendingShare({ api_origin: testCase.apiOrigin ?? "https://api.test" });
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
	it("keeps local shared skill folders still referenced by another project from the same owner", async () => {
		await addToken({
			project_id: "project-a",
			project_name: "A",
			owner_display: "Alice",
			owner_handle: "alice-a3b4",
			token: "a".repeat(43),
			redeemed_at: "2026-05-18T00:00:00.000Z",
			last_seen_skill_keys: ["deploy-tools"],
		});
		await addToken({
			project_id: "project-b",
			project_name: "B",
			owner_display: "Alice",
			owner_handle: "alice-a3b4",
			token: "b".repeat(43),
			redeemed_at: "2026-05-18T00:00:00.000Z",
			last_seen_skill_keys: ["deploy-tools"],
		});

		const dirs = allAdapterEntries().flatMap((entry) => {
			const skills = entry.create().skills;
			return skills ? [skills.sharedPath("deploy-tools", "alice-a3b4")] : [];
		});
		for (const dir of dirs) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), "shared");
		}
		const origLog = console.log;
		console.log = () => {};
		try {
			await inboxForgetCommand("project-a");
		} finally {
			console.log = origLog;
		}

		expect(findToken("project-a")).toBeUndefined();
		expect(findToken("project-b")).toBeDefined();
		for (const dir of dirs) expect(existsSync(dir)).toBe(true);
	});
});
