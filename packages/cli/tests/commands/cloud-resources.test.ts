import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { components } from "@clawdi/shared/api";

const entry = resolve(import.meta.dir, "../../src/index.ts");
const agentId = "123e4567-e89b-42d3-a456-426614174000";
const sessionId = "123e4567-e89b-42d3-a456-426614174001";
const agent: components["schemas"]["AgentResponse"] = {
	id: agentId,
	name: "Default agent name",
	display_name: "My laptop",
	machine_id: "test-machine",
	machine_name: "Test Mac",
	agent_type: "codex",
	agent_version: "1.0.0",
	os: "darwin",
	sort_order: 0,
	last_seen_at: "2026-10-06T12:00:00Z",
	queue_depth_high_water: 0,
	dropped_count: 0,
	sync_enabled: true,
	explicit_identity: false,
	default_project_id: "123e4567-e89b-42d3-a456-426614174002",
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const accessToken = `${encode({ typ: "at+jwt" })}.${encode({ sub: "test-user" })}.signature`;
let taskHome: string;
let server: Bun.Server<undefined>;
let requests: { method: string; path: string; authorization: string | null }[];
let status: number;
let agents: components["schemas"]["AgentResponse"][];

beforeEach(() => {
	taskHome = mkdtempSync(join(tmpdir(), "clawdi-cloud-resources-"));
	requests = [];
	status = 204;
	agents = [agent];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			requests.push({
				method: request.method,
				path,
				authorization: request.headers.get("authorization"),
			});
			if (request.method === "GET" && path === "/v1/agents") return Response.json(agents);
			if (
				request.method === "DELETE" &&
				(path === `/v1/agents/${agentId}` || path === `/v1/sessions/${sessionId}`)
			) {
				return status === 204
					? new Response(null, { status })
					: Response.json({ detail: "Internal test detail must not reach the user" }, { status });
			}
			return Response.json({ detail: "Unexpected test request" }, { status: 404 });
		},
	});
	mkdirSync(join(taskHome, ".clawdi"));
	writeFileSync(
		join(taskHome, ".clawdi", "auth.json"),
		JSON.stringify({
			authType: "clerk_oauth",
			apiKey: accessToken,
			refreshToken: "test-refresh",
			accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			issuer: "https://clerk.example.test",
			clientId: "test-client",
			audience: "clawdi-api",
			tokenEndpoint: "https://clerk.example.test/oauth/token",
			scopes: ["openid"],
			subject: "test-user",
			userId: "test-user",
			endpointBinding: {
				version: 1,
				cloudApiOrigin: server.url.origin,
				hostedApiOrigin: server.url.origin,
			},
		}),
	);
});

afterEach(async () => {
	await server.stop(true);
	rmSync(taskHome, { recursive: true, force: true });
});

async function runCli(args: string[]) {
	const child = Bun.spawn([process.execPath, entry, ...args], {
		cwd: taskHome,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 10_000,
		killSignal: "SIGKILL",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: taskHome,
			CI: "1",
			NO_COLOR: "1",
			CLAWDI_RUNTIME_MODE: "local",
			CLAWDI_API_URL: server.url.origin,
			CLAWDI_DEPLOY_API_URL: server.url.origin,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
		},
	});
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(child.signalCode).toBeNull();
		return { stdout, stderr, code };
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
}

describe("agent list", () => {
	it("lists Cloud agents as JSON using OAuth authentication", async () => {
		const result = await runCli(["agent", "list", "--json"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const payload = JSON.parse(result.stdout);
		expect(payload.schemaVersion).toBe("clawdi.agentList.v1");
		expect(payload.agents).toEqual([
			{
				id: agentId,
				name: "Default agent name",
				display_name: "My laptop",
				agent_type: "codex",
				machine_name: "Test Mac",
				last_seen_at: "2026-10-06T12:00:00Z",
			},
		]);
		expect(requests).toEqual([
			{ method: "GET", path: "/v1/agents", authorization: `Bearer ${accessToken}` },
		]);
	});

	it("aligns columns for different lengths while preserving full IDs and safe names", async () => {
		const secondAgentId = "123e4567-e89b-42d3-a456-426614174003";
		agents = [
			{ ...agent, display_name: "My\x1b[31m laptop" },
			{
				...agent,
				id: secondAgentId,
				name: "Long workstation agent name",
				display_name: null,
				agent_type: "claude_code",
				machine_name: "Build workstation",
				last_seen_at: null,
			},
		];
		const result = await runCli(["agent", "list"]);
		expect(result.code).toBe(0);
		const [header = "", ...rows] = result.stdout.trimEnd().split("\n");
		const columns = ["ID", "Name", "Type", "Machine", "Last activity"];
		for (const column of columns) expect(header).toContain(column);
		expect(rows).toHaveLength(2);
		const expectedRows = [
			[agentId, "My laptop", "codex", "Test Mac", "2026-10-06T12:00:00Z"],
			[secondAgentId, "Long workstation agent name", "claude_code", "Build workstation", "Never"],
		];
		for (const [rowIndex, fields] of expectedRows.entries()) {
			const row = rows[rowIndex] ?? "";
			for (const [columnIndex, field] of fields.entries()) {
				expect(row).toContain(field);
				expect(row.indexOf(field)).toBe(header.indexOf(columns[columnIndex] ?? ""));
			}
		}
		expect(result.stdout).not.toContain("\x1b");
		expect(result.stderr).toBe("");
	});

	it("reports an empty inventory in both formats", async () => {
		agents = [];
		const json = await runCli(["agent", "list", "--json"]);
		expect(json.code).toBe(0);
		const payload = JSON.parse(json.stdout);
		expect(payload.schemaVersion).toBe("clawdi.agentList.v1");
		expect(payload.agents).toEqual([]);
		const text = await runCli(["agent", "list"]);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("No agents found.");
	});
});

for (const command of [
	{
		name: "agent",
		id: agentId,
		path: `/v1/agents/${agentId}`,
		schemaVersion: "clawdi.agentRm.v1",
		status: "disconnected",
	},
	{
		name: "session",
		id: sessionId,
		path: `/v1/sessions/${sessionId}`,
		schemaVersion: "clawdi.sessionRm.v1",
		status: "deleted",
	},
]) {
	describe(`${command.name} rm`, () => {
		it.each(["local-session-id", "", "../other", `${command.id}/permissions`, "123e4567"])(
			"rejects invalid UUID %j before contacting the API",
			async (id) => {
				const result = await runCli([command.name, "rm", id, "--yes", "--json"]);
				expect(result.code).toBe(1);
				expect(result.stderr).toContain("must be a valid UUID");
				expect(result.stdout).toBe("");
				expect(requests).toEqual([]);
			},
		);

		it("requires an ID", async () => {
			const result = await runCli([command.name, "rm", "--yes"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("missing required argument");
			expect(requests).toEqual([]);
		});

		it("requires confirmation in a non-interactive shell", async () => {
			const result = await runCli([command.name, "rm", command.id, "--json"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Confirmation required");
			expect(result.stderr).toContain("--yes");
			if (command.name === "session") {
				expect(result.stderr).toContain("permanently delete this uploaded session");
			}
			expect(result.stdout).toBe("");
			expect(requests).toEqual([]);
		});

		it.each(["-y", "--yes"])("deletes the exact Cloud resource with %s", async (flag) => {
			const result = await runCli([command.name, "rm", command.id, flag, "--json"]);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			const payload = JSON.parse(result.stdout);
			expect(payload.schemaVersion).toBe(command.schemaVersion);
			expect(payload).toEqual({
				schemaVersion: command.schemaVersion,
				id: command.id,
				status: command.status,
			});
			expect(requests).toEqual([
				{ method: "DELETE", path: command.path, authorization: `Bearer ${accessToken}` },
			]);
		});

		it.each([403, 404, 503])("reports HTTP %i safely on stderr", async (code) => {
			status = code;
			const result = await runCli([command.name, "rm", command.id, "--yes", "--json"]);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toContain("Internal test detail");
			if (code === 403) expect(result.stderr).toContain("clawdi auth login");
			if (code === 404) expect(result.stderr).toContain("not found");
			if (code === 503) expect(result.stderr).toContain("Please retry");
		});
	});
}

it("requires authentication for all three commands", async () => {
	unlinkSync(join(taskHome, ".clawdi", "auth.json"));
	for (const args of [
		["agent", "list", "--json"],
		["agent", "rm", agentId, "--yes"],
		["session", "rm", sessionId, "--yes"],
	]) {
		const result = await runCli(args);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("clawdi auth login");
		expect(result.stdout).toBe("");
	}
	expect(requests).toEqual([]);
});

it("shows the new commands under agent and session help", async () => {
	for (const name of ["agent", "session"]) {
		const result = await runCli([name, "--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`rm [options] <${name}-id>`);
		if (name === "agent") expect(result.stdout).toContain("List your agents");
		else expect(result.stdout).toContain("Permanently delete an uploaded session");
	}
	expect(requests).toEqual([]);
});
