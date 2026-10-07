import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jsonResponse } from "./helpers";

const projectId = "00000000-0000-0000-0000-000000000001";
const agentId = "00000000-0000-0000-0000-000000000002";
const itemId = "00000000-0000-0000-0000-000000000003";
const vaultId = "00000000-0000-0000-0000-000000000004";
const secret = "NEVER_PRINT_SECRET_VALUE";
const entry = resolve(import.meta.dir, "../../src/index.ts");
const project = { id: projectId, name: "Team", slug: "team", kind: "workspace", is_owner: true };
const skill = { skill_key: "review", name: "Review", version: 1, file_count: 1 };
const binding = {
	id: itemId,
	agent_id: agentId,
	project_id: projectId,
	binding_type: "context",
	priority: 1,
};
type Call = { method: string; path: string; body: unknown };
let taskHome: string;
let server: ReturnType<typeof Bun.serve>;
let calls: Call[];
let handler: (call: Call) => Response;

beforeEach(() => {
	taskHome = mkdtempSync(join(tmpdir(), "clawdi-batch-e-"));
	mkdirSync(join(taskHome, ".clawdi"));
	mkdirSync(join(taskHome, "bin"));
	for (const command of ["claude", "systemctl", "launchctl"]) {
		writeFileSync(join(taskHome, "bin", command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	}
	calls = [];
	handler = () => jsonResponse({ detail: "Unexpected mock route" }, 404);
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const call = {
				method: req.method,
				path: new URL(req.url).pathname,
				body: req.headers.get("content-type")?.includes("application/json")
					? await req.json()
					: undefined,
			};
			calls.push(call);
			if (call.path === "/v1/projects") return jsonResponse([project]);
			if (call.path === "/v1/projects/default") return jsonResponse({ project_id: projectId });
			if (call.path === `/v1/projects/${projectId}`) return jsonResponse(project);
			return handler(call);
		},
	});
	writeFileSync(
		join(taskHome, ".clawdi/auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			userId: "test-user",
			endpointBinding: { version: 1, cloudApiOrigin: server.url.origin },
		}),
	);
});

afterEach(() => {
	server.stop(true);
	rmSync(taskHome, { recursive: true, force: true });
});

async function cli(args: string[]) {
	const env = { ...process.env };
	for (const key of [
		"CLAUDE_CONFIG_DIR",
		"CODEX_HOME",
		"HERMES_HOME",
		"OPENCLAW_STATE_DIR",
		"DSH_HOME",
		"PI_CODING_AGENT_DIR",
		"PI_CODING_AGENT_SESSION_DIR",
		"CLAWDI_STATE_DIR",
		"CLAWDI_ENVIRONMENT_ID",
		"CLAWDI_SERVICE_STATE_DIR",
		"CLAWDI_RUNTIME_MODE",
		"CLAWDI_SERVE_MODE",
	])
		delete env[key];
	const child = Bun.spawn([process.execPath, entry, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...env,
			HOME: taskHome,
			CLAWDI_HOME: join(taskHome, ".clawdi"),
			PATH: `${join(taskHome, "bin")}:${process.env.PATH ?? ""}`,
			XDG_CONFIG_HOME: join(taskHome, ".config"),
			CLAWDI_AUTH_TOKEN: "",
			CLAWDI_API_URL: server.url.origin,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
			NO_COLOR: "1",
		},
	});
	const timeout = setTimeout(() => child.kill(), 15000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	} finally {
		clearTimeout(timeout);
		if (child.exitCode === null) {
			child.kill();
			await child.exited;
		}
	}
}

async function result(args: string[], name: string, progress?: string) {
	const output = await cli([...args, "--json"]);
	expect({ code: output.code, stderr: output.stderr }).toMatchObject({ code: 0 });
	const body = JSON.parse(output.stdout);
	expect(body.schemaVersion).toBe(`clawdi.${name}.v1`);
	expect(output.stdout + output.stderr).not.toContain(secret);
	if (progress) expect(output.stderr).toContain(progress);
	return body;
}

test("memory mutations emit one result object and route success/category warnings to stderr", async () => {
	handler = () => jsonResponse({ id: itemId });
	expect(
		await result(
			["memory", "add", "Prefer concise notes", "--category", "bad"],
			"memoryAdd",
			"Unknown category",
		),
	).toMatchObject({ id: itemId, category: "fact" });
	expect(await result(["memory", "rm", itemId], "memoryRm", "Deleted memory")).toMatchObject({
		id: itemId,
		status: "deleted",
	});
	expect(calls.filter((call) => call.path.startsWith("/v1/memories"))).toMatchObject([
		{ method: "POST", body: { content: "Prefer concise notes", category: "fact" } },
		{ method: "DELETE", path: `/v1/memories/${itemId}` },
	]);
});

test("skill add/install/rm report cloud mutations while keeping fetching progress off stdout", async () => {
	const file = join(taskHome, "review.md");
	writeFileSync(file, "---\nname: Review\ndescription: Review code\n---\n# Review\n");
	handler = () => jsonResponse(skill);
	expect(
		await result(["skill", "add", file, "--project", projectId], "skillAdd", "Uploaded"),
	).toMatchObject({ project_id: projectId, ...skill });
	expect(
		await result(
			["skill", "install", "team/review", "--project", projectId],
			"skillInstall",
			"Fetching from team/review",
		),
	).toMatchObject({ project_id: projectId, ...skill });
	expect(
		await result(["skill", "rm", "review", "--project", projectId], "skillRm", "Removed review"),
	).toMatchObject({ skill_key: "review", status: "removed" });
	const envDir = join(taskHome, ".clawdi/environments");
	mkdirSync(envDir);
	writeFileSync(
		join(envDir, "claude_code.json"),
		JSON.stringify({ id: agentId, agentType: "claude_code" }),
	);
	handler = (call) =>
		jsonResponse(call.path === `/v1/agents/${agentId}` ? { default_project_id: projectId } : skill);
	await result(["skill", "add", file, "--agent", "claude_code"], "skillAdd", "Uploaded");
	const localSkill = join(taskHome, ".claude/skills/review/SKILL.md");
	expect(existsSync(localSkill)).toBe(true);
	await result(["skill", "rm", "review", "--agent", "claude_code"], "skillRm", "Removed review");
	expect(existsSync(localSkill)).toBe(false);
	writeFileSync(file, "# Missing frontmatter");
	const invalid = await cli(["skill", "add", file, "--json"]);
	expect(invalid.code).toBe(1);
	expect(invalid.stdout).toBe("");
	expect(invalid.stderr).toContain("Example:");
});

test("vault mutations expose key names only and preserve explicit deletion/import confirmation", async () => {
	let attached = false;
	handler = (call) => {
		if (call.path === "/v1/vault" && call.method === "GET")
			return jsonResponse({
				items: [
					{
						id: vaultId,
						slug: "service",
						is_owner: true,
						project_ids: attached ? [projectId] : [],
					},
				],
				total: 1,
			});
		if (call.path === "/v1/vault" && call.method === "POST") attached = true;
		if (call.path === "/v1/vault/service" && call.method === "DELETE") attached = false;
		return jsonResponse({ id: vaultId, secret_value: secret, fields: { KEY: secret } });
	};
	expect(
		await result(
			["vault", "set", "service/KEY", "--value", secret, "--project", projectId],
			"vaultSet",
			"Target:",
		),
	).toMatchObject({ keys: ["KEY"], status: "stored" });
	const file = join(taskHome, ".env");
	writeFileSync(file, `NEXT=${secret}\n`);
	for (const args of [
		["vault", "rm", "service/KEY", "--project", projectId],
		["vault", "import", file, "--vault", "service", "--project", projectId],
	]) {
		const previous = calls.filter((call) => call.method !== "GET").length;
		const refused = await cli([...args, "--json"]);
		expect(refused.code).toBe(1);
		expect(refused.stdout).toBe("");
		expect(refused.stderr).toContain("--yes");
		expect(refused.stderr).not.toContain(secret);
		expect(calls.filter((call) => call.method !== "GET")).toHaveLength(previous);
	}
	expect(
		await result(
			["vault", "import", file, "--vault", "service", "--project", projectId, "--yes"],
			"vaultImport",
			"Imported",
		),
	).toMatchObject({ keys: ["NEXT"], status: "imported" });
	expect(
		await result(
			["vault", "rm", "service/KEY", "--project", projectId, "--yes"],
			"vaultRm",
			"Deleted",
		),
	).toMatchObject({ keys: ["KEY"], status: "deleted" });
	attached = false;
	const args = ["--project", projectId];
	expect(
		await result(["vault", "attach", "service", ...args], "vaultAttach", "Attached"),
	).toMatchObject({ status: "attached" });
	expect(
		await result(["vault", "attach", "service", ...args], "vaultAttach", "already available"),
	).toMatchObject({ status: "already_attached" });
	expect(
		await result(["vault", "detach", "service", ...args], "vaultDetach", "--yes will be required"),
	).toMatchObject({ status: "detached" });
	expect(
		await result(["vault", "detach", "service", ...args], "vaultDetach", "not attached"),
	).toMatchObject({ status: "not_attached" });
	writeFileSync(file, "# Empty dotenv\n");
	expect(await result(["vault", "import", file], "vaultImport", "No keys found")).toMatchObject({
		keys: [],
		status: "empty",
	});
});

test("project sharing covers creation, lists and revoke/cancel with existing deprecation notices", async () => {
	const url = `https://cloud.example.test/share/${"t".repeat(43)}`;
	handler = (call) =>
		jsonResponse(
			call.method === "GET"
				? []
				: {
						id: itemId,
						project_id: projectId,
						url,
						raw_token: "t".repeat(43),
						prefix: "tttt",
						owner_handle: "owner",
						invitee_email: "viewer@example.test",
						label: null,
					},
		);
	const shared = await result(["project", "share", projectId], "projectShare", "link ready");
	expect(shared).toMatchObject({ project_id: projectId, url });
	expect(shared.raw_token).toBeUndefined();
	expect(
		await result(
			["project", "invite", projectId, "--email", "viewer@example.test"],
			"projectInvite",
			"Invitation sent",
		),
	).toMatchObject({ id: itemId });
	expect(await result(["project", "share-links", projectId], "projectShareLinks")).toMatchObject({
		links: [],
	});
	expect(await result(["project", "invites", projectId], "projectInvites")).toMatchObject({
		invitations: [],
	});
	expect(
		await result(
			["project", "share-links", projectId, "--revoke", itemId],
			"projectShareLinks",
			"--yes will be required",
		),
	).toMatchObject({ id: itemId, status: "revoked" });
	expect(
		await result(
			["project", "invites", projectId, "--cancel", itemId],
			"projectInvites",
			"--yes will be required",
		),
	).toMatchObject({ id: itemId, status: "canceled" });
});

test("agent project mutations report link identities and updated priority without human stdout", async () => {
	handler = (call) => jsonResponse(call.method === "GET" ? [binding] : binding);
	const args = [agentId, "--project", projectId];
	expect(
		await result(["agent", "projects", "link", ...args], "agentProjectsLink", "Linked"),
	).toMatchObject({ id: itemId, agent_id: agentId, project_id: projectId });
	expect(
		await result(
			["agent", "projects", "move", agentId, "--item", `${itemId}:2`],
			"agentProjectsMove",
			"priority",
		),
	).toMatchObject({ items: [{ binding_id: itemId, priority: 2 }] });
	expect(
		await result(["agent", "projects", "unlink", ...args], "agentProjectsUnlink", "Unlinked"),
	).toMatchObject({ id: itemId, status: "unlinked" });
});

test("inbox decline/forget emit results without exposing a persisted share credential", async () => {
	handler = () => jsonResponse({ status: "declined" });
	expect(
		await result(["inbox", "decline", itemId], "inboxDecline", "Invitation declined"),
	).toMatchObject({ id: itemId, status: "declined" });
	const token = "s".repeat(43);
	writeFileSync(
		join(taskHome, ".clawdi/share-tokens.json"),
		JSON.stringify({
			version: 1,
			tokens: [
				{
					project_id: projectId,
					project_name: "Team",
					owner_display: "Owner",
					owner_handle: "owner",
					token,
					redeemed_at: "2026-10-01T00:00:00Z",
					last_seen_skill_keys: [],
				},
			],
		}),
	);
	expect(
		await result(["inbox", "forget", projectId], "inboxForget", "--yes will be required"),
	).toMatchObject({ project_id: projectId, status: "forgotten", removed_skill_count: 0 });
	expect(readFileSync(join(taskHome, ".clawdi/share-tokens.json"), "utf8")).not.toContain(token);
});

test("daemon status emits an empty object envelope and registered-agent health through mocked supervisor", async () => {
	expect(await result(["daemon", "status"], "daemonStatus", "No agents registered")).toMatchObject({
		agents: [],
	});
	const envDir = join(taskHome, ".clawdi/environments");
	mkdirSync(envDir);
	writeFileSync(
		join(envDir, "claude_code.json"),
		JSON.stringify({ id: agentId, agentType: "claude_code" }),
	);
	const report = await result(["daemon", "status"], "daemonStatus");
	expect(report.agents).toMatchObject([
		{ agent: "claude_code", health: { exists: false, fresh: false } },
	]);
});

test("setup and teardown report registration, integrations and daemon outcome with progress on stderr", async () => {
	handler = () =>
		jsonResponse({
			id: agentId,
			dashboard_url: "https://cloud.example.test/dashboard",
			secret_value: secret,
		});
	const setup = await result(
		["setup", "--agent", "claude_code", "--yes", "--no-daemon"],
		"setup",
		"MCP server registered",
	);
	expect(setup).toMatchObject({
		agents: [
			{ id: agentId, agent_type: "claude_code", skill_installed: true, mcp_installed: true },
		],
		daemon: { installed: false },
		dashboard_url: "https://cloud.example.test/dashboard",
	});
	expect(
		await result(
			["teardown", "--agent", "claude_code", "--yes"],
			"teardown",
			"removed MCP server registration",
		),
	).toMatchObject({
		agents: [
			{
				agent_type: "claude_code",
				registration_removed: true,
				skill: "removed",
				mcp: "removal_attempted",
			},
		],
	});
	expect(existsSync(join(taskHome, ".clawdi/environments/claude_code.json"))).toBe(false);
	// The source CLI intentionally refuses supervisor installation from a .ts entry.
	// Registration still succeeds; JSON must report the partial result and preserve exit 1.
	const withDaemon = await cli(["setup", "--agent", "claude_code", "--yes", "--json"]);
	expect(withDaemon.code).toBe(1);
	expect(withDaemon.stderr).toContain("Could not install daemon");
	expect(JSON.parse(withDaemon.stdout)).toMatchObject({
		schemaVersion: "clawdi.setup.v1",
		status: "partial",
		daemon: { installed: false },
		agents: [{ id: agentId, skill_installed: true, mcp_installed: true }],
	});
	await result(["teardown", "--agent", "claude_code", "--yes"], "teardown", "Teardown complete");

	expect(
		await result(["teardown", "--all", "--yes"], "teardown", "Nothing to tear down"),
	).toMatchObject({ agents: [], status: "nothing_to_teardown" });
});
