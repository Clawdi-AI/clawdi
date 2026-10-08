import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../../src/index.ts");
const projectId = "00000000-0000-0000-0000-000000000123";
let testHome: string;
let server: Bun.Server<undefined>;
let mutations: string[];
let catalogPath: string;
let initialCatalog: string;

beforeEach(() => {
	testHome = mkdtempSync(join(tmpdir(), "clawdi-confirmation-"));
	mutations = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			const route = `${request.method} ${path}`;
			if (route === "POST /v1/vault/credential-profiles/resolve") {
				return Response.json({
					payload: JSON.stringify({
						schemaVersion: 1,
						kind: "local_agent_profile",
						tool: "gh",
						profile: "default",
						importedAt: "2026-10-06T00:00:00Z",
						files: [
							{
								logicalName: "credential.txt",
								sourcePath: "/source/credential.txt",
								targetStrategy: "explicit",
								targetPath: join(testHome, "target.txt"),
								content: "new-auth",
								mode: 0o600,
								size: 8,
							},
						],
					}),
				});
			}
			if (request.method !== "GET") mutations.push(route);
			switch (route) {
				case "GET /v1/ai-providers":
					return Response.json({ providers: [] });
				case "GET /v1/projects/default":
					return Response.json({ project_id: projectId });
				case "GET /v1/projects":
					return Response.json([
						{
							id: projectId,
							slug: "engineering",
							name: "Engineering",
							kind: "shared",
							is_owner: true,
						},
					]);
				case `GET /v1/projects/${projectId}`:
					return Response.json({ id: projectId, kind: "shared" });
				case `GET /v1/projects/${projectId}/members`:
					return Response.json([{ user_id: "user-bob", user_email: "bob@example.test" }]);
				case "GET /v1/agents/00000000-0000-0000-0000-000000000101/skills":
					return Response.json({
						skills: [{ skill_key: "library-key", authority: "cloud", skill_id: "library-test" }],
					});
				case "GET /v1/agents/00000000-0000-0000-0000-000000000101/project-bindings":
					return Response.json([
						{ id: "binding-test", binding_type: "context", project_id: projectId },
					]);
				case "GET /v1/vault":
					return Response.json({
						items: [{ id: "vault-test", slug: "default", project_id: projectId }],
						total: 1,
					});
				case "POST /v1/vault":
					return Response.json({ id: "vault-test", slug: "default" });
				case "POST /v1/vault/credential-profiles":
					return Response.json({ tool: "gh", profile: "default" });
				case "POST /v1/ai-providers":
					return Response.json({
						provider_id: "openai-test",
						auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
					});
				case "POST /v1/ai-providers/openai-test/auth/import":
					return Response.json({
						provider_id: "openai-test",
						auth: { type: "agent_profile", tool: "codex", profile: "default" },
					});
				case `POST /v1/projects/${projectId}/leave`:
					return Response.json({ status: "left" });
				case `POST /v1/projects/${projectId}/unshare`:
					return Response.json({ links_revoked: 1, members_removed: 1, invitations_cancelled: 1 });
				case "DELETE /v1/vault/default/items":
				case "PUT /v1/vault/default/items":
				case `DELETE /v1/projects/${projectId}/members/user-bob`:
				case `DELETE /v1/projects/${projectId}/skills/test-skill`:
				case `DELETE /v1/projects/${projectId}/share-links/00000000-0000-0000-0000-000000000124`:
				case `DELETE /v1/projects/${projectId}/invitations/invitation-test`:
				case "DELETE /v1/agents/00000000-0000-0000-0000-000000000101/skill-references/library-test":
				case "DELETE /v1/vault/default":
				case "DELETE /v1/memories/memory-test":
				case "DELETE /v1/agents/00000000-0000-0000-0000-000000000101/project-bindings/binding-test":
				case "DELETE /v1/channels/channel-test":
				case "POST /v1/me/invitations/invitation-test/decline":
					return Response.json({ status: "ok" });
				default:
					return Response.json({ detail: `Unexpected test request: ${route}` }, { status: 404 });
			}
		},
	});
	mkdirSync(join(testHome, ".clawdi", "ai-providers"), { recursive: true });
	mkdirSync(join(testHome, ".clawdi", "environments"));
	writeFileSync(
		join(testHome, ".clawdi", "auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			endpointBinding: { version: 1, cloudApiOrigin: server.url.origin },
		}),
	);
	writeFileSync(
		join(testHome, ".clawdi", "environments", "claude_code.json"),
		JSON.stringify({ id: "00000000-0000-0000-0000-000000000101", agentType: "claude_code" }),
	);
	writeFileSync(
		join(testHome, ".clawdi", "share-tokens.json"),
		JSON.stringify({
			version: 1,
			tokens: [
				{
					project_id: projectId,
					project_name: "Engineering",
					owner_display: "Alice",
					owner_handle: "alice",
					token: "a".repeat(43),
					redeemed_at: "2026-08-27T12:00:00Z",
					last_seen_skill_keys: [],
				},
			],
		}),
	);
	writeFileSync(join(testHome, "credential.txt"), "test-credential");
	writeFileSync(join(testHome, "target.txt"), "old-auth");
	writeFileSync(join(testHome, ".env"), "EXAMPLE_KEY=test-value\n");
	writeFileSync(
		join(testHome, "SKILL.md"),
		"---\nname: Test\ndescription: Test skill\n---\n# Test\n",
	);
	catalogPath = join(testHome, ".clawdi", "ai-providers", "catalog.json");
	initialCatalog = JSON.stringify({
		schema_version: 1,
		providers: [
			{
				id: "openai-test",
				type: "openai",
				base_url: "https://api.openai.com/v1",
				api_mode: "openai_responses",
				auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
			},
		],
	});
	writeFileSync(catalogPath, initialCatalog);
});

afterEach(async () => {
	await server.stop(true);
	rmSync(testHome, { recursive: true, force: true });
});

async function runCli(args: string[], stdin: "ignore" | "pipe" = "ignore") {
	const child = Bun.spawn([process.execPath, entry, ...args], {
		cwd: testHome,
		stdin,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 10_000,
		killSignal: "SIGKILL",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: testHome,
			CI: "1",
			CLAWDI_RUNTIME_MODE: "local",
			CLAWDI_API_URL: server.url.origin,
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

const promptCommands = [
	{
		name: "vault rm",
		args: ["vault", "rm", "EXAMPLE_KEY"],
		mutation: "DELETE /v1/vault/default/items",
	},
	{
		name: "agent credentials import",
		args: [
			"agent",
			"credentials",
			"import",
			"gh",
			"--from",
			"credential.txt",
			"--to",
			"target.txt",
		],
		mutation: "POST /v1/vault/credential-profiles",
	},
	{
		name: "agent credentials materialize",
		args: ["agent", "credentials", "materialize", "gh", "--to", "target.txt"],
		mutation: null,
	},
	{
		name: "vault import",
		args: ["vault", "import", ".env"],
		mutation: "PUT /v1/vault/default/items",
	},
	{
		name: "ai-provider import-auth",
		args: [
			"ai-provider",
			"import-auth",
			"openai-test",
			"--tool",
			"codex",
			"--from",
			"credential.txt",
			"--json",
		],
		mutation: "POST /v1/ai-providers/openai-test/auth/import",
	},
];

describe("non-interactive confirmations", () => {
	for (const command of promptCommands) {
		it.each(["ignore", "pipe"] as const)(
			`${command.name} requires --yes with stdin %s`,
			async (stdin) => {
				const result = await runCli(command.args, stdin);
				expect(result.code).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("Confirmation required to ");
				expect(result.stderr).toContain("Re-run with --yes in a non-interactive shell.");
				expect(mutations).toEqual([]);
				expect(readFileSync(join(testHome, "target.txt"), "utf8")).toBe("old-auth");
				expect(readFileSync(catalogPath, "utf8")).toBe(initialCatalog);
				expect(readdirSync(testHome).filter((name) => name.startsWith("target.txt.bak-"))).toEqual(
					[],
				);
			},
		);

		it.each(["--yes", "-y"])(`${command.name} proceeds with %s`, async (yes) => {
			const result = await runCli([...command.args, yes]);
			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain("Confirmation required");
			if (command.mutation) expect(mutations).toContain(command.mutation);
			else expect(readFileSync(join(testHome, "target.txt"), "utf8")).toBe("new-auth");
			if (command.name === "ai-provider import-auth") {
				expect(JSON.parse(result.stdout).auth.type).toBe("agent_profile");
				expect(JSON.parse(readFileSync(catalogPath, "utf8")).providers[0].auth.type).toBe(
					"agent_profile",
				);
			}
		});
	}

	const destructiveCommands = [
		["project", "unshare", projectId, "--json"],
		["project", "members", projectId, "--remove", "bob@example.test", "--json"],
		["project", "leave", projectId, "--json"],
		["teardown", "--agent", "claude_code", "--keep-skill", "--keep-mcp"],
		["memory", "rm", "memory-test"],
		["skill", "rm", "test-skill", "--project", projectId],
		["ai-provider", "remove", "openai-test", "--json"],
		["agent", "projects", "unlink", "00000000-0000-0000-0000-000000000101", "--project", projectId],
		["inbox", "decline", "invitation-test"],
		["channel", "delete", "channel-test"],
		["agent", "skills", "rm", "00000000-0000-0000-0000-000000000101", "library-key"],
		["project", "share-links", projectId, "--revoke", "00000000-0000-0000-0000-000000000124"],
		["project", "invites", projectId, "--cancel", "invitation-test"],
		["vault", "detach", "default", "--project", projectId],
		["inbox", "forget", projectId],
	];

	for (const args of destructiveCommands) {
		it.each(["ignore", "pipe"] as const)(
			`${args.join(" ")} requires --yes with stdin %s`,
			async (stdin) => {
				const result = await runCli(args, stdin);
				expect(result.code).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("Confirmation required to ");
				expect(result.stderr).toContain("Re-run with --yes in a non-interactive shell.");
				expect(mutations).toEqual([]);
				expect(readFileSync(catalogPath, "utf8")).toBe(initialCatalog);
				expect(existsSync(join(testHome, ".clawdi", "environments", "claude_code.json"))).toBe(
					true,
				);
			},
		);

		it.each(["--yes", "-y"])(`${args.join(" ")} proceeds with %s`, async (yes) => {
			const result = await runCli([...args, yes]);
			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain("Confirmation required");
			if (args[0] === "teardown") {
				expect(existsSync(join(testHome, ".clawdi", "environments", "claude_code.json"))).toBe(
					false,
				);
			} else if (args[0] === "inbox" && args[1] === "forget") {
				expect(mutations).toEqual([]);
				expect(
					JSON.parse(readFileSync(join(testHome, ".clawdi", "share-tokens.json"), "utf8")).tokens,
				).toEqual([]);
			} else if (args[0] === "ai-provider") {
				expect(JSON.parse(readFileSync(catalogPath, "utf8")).providers).toEqual([]);
			} else {
				expect(mutations).toHaveLength(1);
			}
		});
	}

	it("lists project members without confirmation", async () => {
		const result = await runCli(["project", "members", projectId, "--json"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(mutations).toEqual([]);
	});

	const removedSurfaces = [
		{
			args: ["vault", "unlink", "default", "--project", projectId],
			error: "unknown command 'unlink'",
		},
		{
			args: [
				"agent",
				"projects",
				"attach",
				"00000000-0000-0000-0000-000000000101",
				"--project",
				projectId,
			],
			error: "unknown command 'attach'",
		},
		{
			args: [
				"agent",
				"projects",
				"detach",
				"00000000-0000-0000-0000-000000000101",
				"--project",
				projectId,
			],
			error: "unknown command 'detach'",
		},
		{ args: ["serve", "status"], error: "unknown command 'serve'" },
		{ args: ["ai-provider", "test", "openai-test", "--probe"], error: "unknown option '--probe'" },
		{
			args: ["ai-provider", "test", "openai-test", "--no-probe"],
			error: "unknown option '--no-probe'",
		},
		{ args: ["project", "list", "--include-envs"], error: "unknown option '--include-envs'" },
		{
			args: ["inbox", "accept", "invitation-test", "--use-as", "attached"],
			error: "unknown option '--use-as'",
		},
		{
			args: ["inbox", "join", projectId, "--use-as", "attached"],
			error: "unknown option '--use-as'",
		},
	];
	for (const surface of removedSurfaces) {
		it(`rejects ${surface.args.join(" ")} before dispatch`, async () => {
			const result = await runCli(surface.args);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(surface.error);
			expect(mutations).toEqual([]);
		});
	}
});
