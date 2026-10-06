import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tarSkillDir } from "../../src/lib/tar";
import { cleanupTmp, copyFixtureToTmp } from "../adapters/helpers";
import { seedAuthAndEnv } from "./helpers";

const entry = resolve(import.meta.dir, "../../src/index.ts");
const projectId = "00000000-0000-0000-0000-000000000099";
const localSessionId = "11111111-2222-3333-4444-555555555555";
let testHome = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let requests: { method: string; path: string }[] = [];
let remoteSessions: ReturnType<typeof remoteSession>[] = [];
let cloudSkills: { skill_key: string; name: string; content_hash: string }[] = [];
let override: (request: Request) => Promise<Response | null>;

function remoteSession(id: string, hash = `hash-${id}`) {
	return {
		id,
		local_session_id: id,
		agent_type: "claude_code",
		machine_name: "Test machine",
		project_path: "/test/project",
		started_at: "2026-10-06T00:00:00Z",
		ended_at: null,
		message_count: 1,
		model: null,
		summary: null,
		content_hash: hash,
	};
}

beforeEach(() => {
	testHome = copyFixtureToTmp("claude_code");
	seedAuthAndEnv(testHome, "claude_code");
	requests = [];
	remoteSessions = [];
	cloudSkills = [];
	override = async () => null;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			requests.push({ method: request.method, path });
			const response = await override(request);
			if (response) return response;
			if (/^\/v1\/agents\/[^/]+$/.test(path)) {
				return Response.json({ id: path.split("/").at(-1), default_project_id: projectId });
			}
			if (path === "/v1/sessions/batch") {
				const body: { sessions: unknown[] } = await request.json();
				return Response.json({
					created: body.sessions.length,
					updated: 0,
					unchanged: 0,
					needs_content: [],
				});
			}
			if (path.endsWith("/skills/sync/upload")) return Response.json({});
			if (path === "/v1/sessions") return Response.json({ items: remoteSessions });
			if (path.endsWith("/content")) return Response.json([{ role: "user", content: "test" }]);
			if (path === "/v1/projects") {
				return Response.json([{ id: projectId, name: "Test", kind: "workspace", is_owner: true }]);
			}
			if (path === "/v1/skills") return Response.json({ items: cloudSkills });
			return Response.json({ detail: "Not found" }, { status: 404 });
		},
	});
	writeFileSync(
		join(testHome, ".clawdi", "auth.json"),
		JSON.stringify({
			apiKey: "test-key",
			userId: "test-user",
			endpointBinding: { version: 1, cloudApiOrigin: server.url.origin },
		}),
	);
});

afterEach(() => {
	server?.stop(true);
	server = undefined;
	cleanupTmp(testHome);
});

async function runCli(args: string[]) {
	if (!server) throw new Error("Test server was not started");
	const child = Bun.spawn([process.execPath, entry, ...args], {
		cwd: testHome,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
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
	const timer = setTimeout(() => child.kill(), 10_000);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(child.signalCode).toBeNull();
		return { stdout, stderr, exitCode };
	} catch (error) {
		child.kill();
		await child.exited;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function expectPlain(output: string): void {
	expect(output).not.toContain("\u001b");
	expect(output).not.toContain("\u009b");
	expect(output).not.toMatch(/[\u2500-\u257f]/);
}

function seedMirror(id: string, hash: string): void {
	const directory = join(testHome, ".clawdi", "sessions", "claude_code");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, `${id}.meta.json`), JSON.stringify({ content_hash: hash }));
	writeFileSync(join(directory, `${id}.json`), "[]\n");
}

describe("push/pull output contracts", () => {
	it.each([false, true])(
		"omits persisted project exclusions from push JSON counts (dryRun=%s)",
		async (dryRun) => {
			const config = await runCli(["config", "set", "excludeProjects", "/Users/fixture/project/."]);
			expect(config.exitCode).toBe(0);
			const result = await runCli([
				"push",
				"--agent",
				"claude_code",
				"--all",
				"--modules",
				"sessions",
				"--json",
				"--no-color",
				...(dryRun ? ["--dry-run"] : []),
			]);
			expect(result.exitCode).toBe(0);
			const sessions = { new: 0, updated: 0, unchanged: 0, failed: 0 };
			expect(JSON.parse(result.stdout)).toEqual({
				schemaVersion: "clawdi.push.v1",
				dryRun,
				agents: [{ agent: "claude_code", sessions }],
				totals: { sessions, skills: { uploaded: 0, unchanged: 0, failed: 0 } },
				errors: [],
			});
			expect(requests.some((request) => request.path === "/v1/sessions/batch")).toBe(false);
			expect(existsSync(join(testHome, ".clawdi", "sessions-lock.json"))).toBe(false);
			expect(result.stderr).toContain("Excluded 1 session from 1 project.");
			expectPlain(result.stderr);
			if (dryRun) expect(requests).toHaveLength(0);
		},
	);

	it.each([false, true])(
		"unions persisted and flag exclusions before push JSON counts with exact paths (dryRun=%s)",
		async (dryRun) => {
			const fixture = readFileSync(
				join(testHome, ".claude", "projects", "-Users-fixture-project", `${localSessionId}.jsonl`),
				"utf8",
			);
			for (const [project, id] of [
				["/scratch", "22222222-2222-3333-4444-555555555555"],
				["/Users/fixture/project/child", "33333333-2222-3333-4444-555555555555"],
			]) {
				const directory = join(testHome, ".claude", "projects", project.replaceAll("/", "-"));
				mkdirSync(directory, { recursive: true });
				writeFileSync(
					join(directory, `${id}.jsonl`),
					fixture.replaceAll(localSessionId, id).replaceAll("/Users/fixture/project", project),
				);
			}
			expect(
				(await runCli(["config", "set", "excludeProjects", "/Users/fixture/project"])).exitCode,
			).toBe(0);
			const result = await runCli([
				"push",
				"--agent",
				"claude_code",
				"--all",
				"--modules",
				"sessions",
				"--exclude-project",
				"/scratch/.",
				"--json",
				"--no-color",
				...(dryRun ? ["--dry-run"] : []),
			]);
			expect(result.exitCode).toBe(0);
			const sessions = { new: 1, updated: 0, unchanged: 0, failed: 0 };
			expect(JSON.parse(result.stdout)).toEqual({
				schemaVersion: "clawdi.push.v1",
				dryRun,
				agents: [{ agent: "claude_code", sessions }],
				totals: { sessions, skills: { uploaded: 0, unchanged: 0, failed: 0 } },
				errors: [],
			});
			expect(result.stderr).toContain("Excluded 2 sessions from 2 projects.");
			expectPlain(result.stderr);
			if (dryRun) expect(requests).toHaveLength(0);
		},
	);

	it.each(["push", "pull"])("prints plain non-TTY %s progress only to stderr", async (command) => {
		const result = await runCli([
			command,
			"--agent",
			"claude_code",
			"--modules",
			"sessions",
			"--all",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Scanning 1 agent");
		expect(result.stderr).toContain("Scan complete.");
		expectPlain(result.stdout + result.stderr);
	});

	it("reports push totals, per-agent counts, and unchanged items on repeat pushes", async () => {
		const args = ["push", "--agent", "claude_code", "--all", "--json"];
		const first = await runCli(args);
		expect(first.exitCode).toBe(0);
		const sessions = { new: 1, updated: 0, unchanged: 0, failed: 0 };
		const skills = { uploaded: 1, unchanged: 0, failed: 0 };
		expect(JSON.parse(first.stdout)).toEqual({
			schemaVersion: "clawdi.push.v1",
			dryRun: false,
			agents: [{ agent: "claude_code", sessions, skills }],
			totals: { sessions, skills },
			errors: [],
		});
		const second = await runCli(args);
		expect(second.exitCode).toBe(0);
		expect(JSON.parse(second.stdout)).toMatchObject({
			agents: [{ agent: "claude_code", sessions: { unchanged: 1 }, skills: { unchanged: 1 } }],
			totals: {
				sessions: { new: 0, updated: 0, unchanged: 1, failed: 0 },
				skills: { uploaded: 0, unchanged: 1, failed: 0 },
			},
			errors: [],
		});
		expectPlain(first.stderr + second.stderr);
	});

	it("aggregates push counts across agents and omits modules that were not run", async () => {
		cpSync(resolve(import.meta.dir, "../fixtures/codex"), testHome, { recursive: true });
		writeFileSync(
			join(testHome, ".clawdi", "environments", "codex.json"),
			JSON.stringify({ id: "env-codex", agentType: "codex" }),
		);
		const result = await runCli(["push", "--all", "--modules", "sessions", "--json"]);
		expect(result.exitCode).toBe(0);
		const counts = { new: 1, updated: 0, unchanged: 0, failed: 0 };
		expect(JSON.parse(result.stdout)).toEqual({
			schemaVersion: "clawdi.push.v1",
			dryRun: false,
			agents: [
				{ agent: "claude_code", sessions: counts },
				{ agent: "codex", sessions: counts },
			],
			totals: {
				sessions: { ...counts, new: 2 },
				skills: { uploaded: 0, unchanged: 0, failed: 0 },
			},
			errors: [],
		});
	});

	it("reports push dry-run plans without network calls or sync state writes", async () => {
		const result = await runCli(["push", "--agent", "claude_code", "--all", "--dry-run", "--json"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: "clawdi.push.v1",
			dryRun: true,
			totals: {
				sessions: { new: 1, updated: 0, unchanged: 0, failed: 0 },
				skills: { uploaded: 1, unchanged: 0, failed: 0 },
			},
			errors: [],
		});
		expect(requests).toHaveLength(0);
		for (const name of ["sessions-lock.json", "skills-lock.json", "state.json"]) {
			expect(existsSync(join(testHome, ".clawdi", name))).toBe(false);
		}
	});

	it("reports updated push dry-run sessions from the existing scan cache", async () => {
		const initial = await runCli([
			"push",
			"--agent",
			"claude_code",
			"--all",
			"--modules",
			"sessions",
		]);
		expect(initial.exitCode).toBe(0);
		const path = join(testHome, ".clawdi", "sessions-lock.json");
		const before = readFileSync(path, "utf8");
		requests = [];
		const preview = await runCli([
			"push",
			"--agent",
			"claude_code",
			"--all",
			"--modules",
			"sessions",
			"--dry-run",
			"--json",
		]);
		expect(preview.exitCode).toBe(0);
		expect(JSON.parse(preview.stdout).totals.sessions).toEqual({
			new: 0,
			updated: 1,
			unchanged: 0,
			failed: 0,
		});
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(requests).toHaveLength(0);
	});

	it("returns push item errors and exit 1 while preserving successful counts", async () => {
		override = async (request) =>
			request.url.endsWith("/skills/sync/upload")
				? Response.json({ detail: "Payload too large" }, { status: 413 })
				: null;
		const result = await runCli(["push", "--agent", "claude_code", "--all", "--json"]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			totals: {
				sessions: { new: 1, updated: 0, unchanged: 0, failed: 0 },
				skills: { uploaded: 0, unchanged: 0, failed: 1 },
			},
			errors: [
				{
					agent: "claude_code",
					module: "skills",
					key: "demo",
					message: expect.stringContaining("exceeds upload limit"),
				},
			],
		});
		expect(result.stderr).toContain("Skipped demo");
		expectPlain(result.stderr);
	});

	it("prints a full push document for a metadata failure after scanning", async () => {
		override = async (request) =>
			request.url.endsWith("/sessions/batch")
				? Response.json({ detail: "Metadata refused" }, { status: 400 })
				: null;
		const result = await runCli([
			"push",
			"--agent",
			"claude_code",
			"--all",
			"--modules",
			"sessions",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: "clawdi.push.v1",
			totals: { sessions: { new: 0, updated: 0, unchanged: 0, failed: 1 } },
			errors: [
				{
					agent: "claude_code",
					module: "sessions",
					key: localSessionId,
					message: expect.stringContaining("Metadata refused"),
				},
			],
		});
		expect(result.stderr).toContain("Metadata refused");
	});

	it("counts failed push content syncs and writes their errors to stderr", async () => {
		override = async (request) => {
			if (request.url.endsWith("/sessions/batch")) {
				return Response.json({
					created: 1,
					updated: 0,
					unchanged: 0,
					needs_content: [localSessionId],
				});
			}
			return request.url.endsWith("/upload")
				? Response.json({ detail: "Content refused" }, { status: 400 })
				: null;
		};
		const result = await runCli([
			"push",
			"--agent",
			"claude_code",
			"--all",
			"--modules",
			"sessions",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			totals: { sessions: { new: 1, failed: 1 } },
			errors: [
				{
					agent: "claude_code",
					module: "sessions",
					key: localSessionId,
					message: expect.stringContaining("Content refused"),
				},
			],
		});
		expect(result.stderr).toContain("Content sync failed");
	});

	it("reports server-rejected push sessions as item failures", async () => {
		override = async (request) =>
			request.url.endsWith("/sessions/batch")
				? Response.json({
						created: 0,
						updated: 0,
						unchanged: 0,
						needs_content: [],
						rejected: [localSessionId],
					})
				: null;
		const result = await runCli([
			"push",
			"--agent",
			"claude_code",
			"--all",
			"--modules",
			"sessions",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			totals: { sessions: { new: 0, updated: 0, unchanged: 0, failed: 1 } },
			errors: [
				{
					agent: "claude_code",
					module: "sessions",
					key: localSessionId,
					message: expect.stringContaining("rejected by server"),
				},
			],
		});
		expect(result.stderr).toContain("rejected by server");
	});

	it("reports pull new, updated, and unchanged sessions and repeats without downloading", async () => {
		remoteSessions = [remoteSession("new"), remoteSession("updated"), remoteSession("same")];
		seedMirror("updated", "old-hash");
		seedMirror("same", "hash-same");
		const args = ["pull", "--agent", "claude_code", "--modules", "sessions", "--json"];
		const first = await runCli(args);
		expect(first.exitCode).toBe(0);
		const sessions = { new: 1, updated: 1, unchanged: 1, failed: 0 };
		expect(JSON.parse(first.stdout)).toEqual({
			schemaVersion: "clawdi.pull.v1",
			dryRun: false,
			agents: [{ agent: "claude_code", sessions }],
			totals: { sessions, skills: { downloaded: 0, unchanged: 0, failed: 0 } },
			errors: [],
		});
		requests = [];
		const second = await runCli(args);
		expect(second.exitCode).toBe(0);
		expect(JSON.parse(second.stdout).totals.sessions).toEqual({
			new: 0,
			updated: 0,
			unchanged: 3,
			failed: 0,
		});
		expect(requests.some((request) => request.path.endsWith("/content"))).toBe(false);
	});

	it("reports pull dry-run counts without downloads or local writes", async () => {
		remoteSessions = [remoteSession("new"), remoteSession("updated"), remoteSession("same")];
		seedMirror("updated", "old-hash");
		seedMirror("same", "hash-same");
		const result = await runCli([
			"pull",
			"--agent",
			"claude_code",
			"--modules",
			"sessions",
			"--dry-run",
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			dryRun: true,
			totals: { sessions: { new: 1, updated: 1, unchanged: 1, failed: 0 } },
			errors: [],
		});
		expect(requests.some((request) => request.path.endsWith("/content"))).toBe(false);
		const mirror = join(testHome, ".clawdi", "sessions", "claude_code");
		expect(existsSync(join(mirror, "new.json"))).toBe(false);
		expect(JSON.parse(readFileSync(join(mirror, "updated.meta.json"), "utf8")).content_hash).toBe(
			"old-hash",
		);
	});

	it("reports imported pull skills and unchanged skills on repeat pulls", async () => {
		cloudSkills = [{ skill_key: "demo", name: "Demo", content_hash: "demo-hash" }];
		const archive = await tarSkillDir(join(testHome, ".claude", "skills", "demo"));
		override = async (request) =>
			request.url.endsWith("/download") ? new Response(new Uint8Array(archive)) : null;
		const args = [
			"pull",
			"--agent",
			"claude_code",
			"--modules",
			"skills",
			"--project",
			projectId,
			"--json",
		];
		const first = await runCli(args);
		expect(first.exitCode).toBe(0);
		const skills = { downloaded: 1, unchanged: 0, failed: 0 };
		expect(JSON.parse(first.stdout)).toEqual({
			schemaVersion: "clawdi.pull.v1",
			dryRun: false,
			agents: [{ agent: "claude_code", skills }],
			totals: { sessions: { new: 0, updated: 0, unchanged: 0, failed: 0 }, skills },
			errors: [],
		});
		const second = await runCli(args);
		expect(second.exitCode).toBe(0);
		expect(JSON.parse(second.stdout).totals.skills).toEqual({
			downloaded: 0,
			unchanged: 1,
			failed: 0,
		});
	});

	it("returns pull session errors and exit 1 without losing successful downloads", async () => {
		remoteSessions = [remoteSession("good"), remoteSession("bad")];
		override = async (request) =>
			request.url.endsWith("/bad/content")
				? Response.json({ detail: "Content refused" }, { status: 400 })
				: null;
		const result = await runCli([
			"pull",
			"--agent",
			"claude_code",
			"--modules",
			"sessions",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			totals: { sessions: { new: 1, updated: 0, unchanged: 0, failed: 1 } },
			errors: [
				{
					agent: "claude_code",
					module: "sessions",
					key: "bad",
					message: expect.stringContaining("Content refused"),
				},
			],
		});
		expect(result.stderr).toContain("bad failed");
		expectPlain(result.stderr);
	});

	it("returns pull skill errors and exit 1", async () => {
		cloudSkills = [{ skill_key: "bad", name: "Bad", content_hash: "bad-hash" }];
		override = async (request) =>
			request.url.endsWith("/download")
				? Response.json({ detail: "Download refused" }, { status: 400 })
				: null;
		const result = await runCli([
			"pull",
			"--agent",
			"claude_code",
			"--modules",
			"skills",
			"--project",
			projectId,
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			totals: { skills: { downloaded: 0, unchanged: 0, failed: 1 } },
			errors: [
				{
					agent: "claude_code",
					module: "skills",
					key: "bad",
					message: expect.stringContaining("Download refused"),
				},
			],
		});
		expect(result.stderr).toContain("bad failed");
	});

	it("keeps stdout empty on pull errors before the scan completes", async () => {
		override = async (request) =>
			new URL(request.url).pathname === "/v1/sessions"
				? Response.json({ detail: "Session list refused" }, { status: 400 })
				: null;
		const result = await runCli([
			"pull",
			"--agent",
			"claude_code",
			"--modules",
			"sessions",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Session list refused");
	});

	it.each(["push", "pull"])("keeps stdout empty on signed-out %s --json", async (command) => {
		rmSync(join(testHome, ".clawdi", "auth.json"));
		const result = await runCli([command, "--json"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Not signed in");
		expect(requests).toHaveLength(0);
	});
});
