import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readBoundedResponseBytes,
	skillAdd,
	skillInit,
	skillInstall,
	skillRm,
} from "../../src/commands/skill";
import { readSkillProjectionState, recordSkillProjectionClaim } from "../../src/lib/skills-lock";
import { tarSkillDir } from "../../src/lib/tar";
import { reserveManagedSkill } from "../../src/runtime/managed-skill-reservation";
import {
	type AgentHomeOverrideSnapshot,
	jsonResponse,
	mockFetch,
	okEnvironmentProbe,
	restoreAgentHomeOverrides,
	seedAuthAndEnv,
	snapshotAndClearAgentHomeOverrides,
} from "./helpers";

let tmpHome: string;
let origCwd: string;
let origHome: string | undefined;
let agentHomeOverrides: AgentHomeOverrideSnapshot;

beforeEach(() => {
	origCwd = process.cwd();
	origHome = process.env.HOME;
	agentHomeOverrides = snapshotAndClearAgentHomeOverrides();
	tmpHome = join(tmpdir(), `clawdi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpHome, { recursive: true });
	process.env.HOME = tmpHome;
	process.chdir(tmpHome);
});

afterEach(() => {
	process.chdir(origCwd);
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	restoreAgentHomeOverrides(agentHomeOverrides);
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("skillInit", () => {
	it("writes SKILL.md template when given a name", () => {
		skillInit("my-skill");
		const p = join(tmpHome, "my-skill", "SKILL.md");
		expect(existsSync(p)).toBe(true);
		const content = readFileSync(p, "utf-8");
		expect(content).toContain("---\nname: my-skill");
		expect(content).toContain("description: A brief description");
	});

	it("writes SKILL.md in the current directory when no name is given", () => {
		// basename(cwd) → last path segment of tmpdir
		skillInit();
		const p = join(tmpHome, "SKILL.md");
		expect(existsSync(p)).toBe(true);
	});

	it("does not overwrite an existing SKILL.md", () => {
		const existing = join(tmpHome, "existing-skill");
		mkdirSync(existing, { recursive: true });
		writeFileSync(join(existing, "SKILL.md"), "ORIGINAL CONTENT");
		// skillInit uses cwd's name if none passed; pass explicit to hit the named path
		skillInit("existing-skill");
		expect(readFileSync(join(existing, "SKILL.md"), "utf-8")).toBe("ORIGINAL CONTENT");
	});

	it("sanitizes the name to kebab-case", () => {
		skillInit("My Cool Skill!");
		expect(existsSync(join(tmpHome, "my-cool-skill", "SKILL.md"))).toBe(true);
	});

	it("caps generated skill directory names at the backend skill_key limit", () => {
		skillInit("a".repeat(300));
		const generated = "a".repeat(200);
		expect(existsSync(join(tmpHome, generated, "SKILL.md"))).toBe(true);
	});
});

describe("bounded GitHub archive download", () => {
	it("cancels an unbounded stream as soon as it crosses the byte limit", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3, 4]));
				controller.enqueue(new Uint8Array([5]));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(body);
		await expect(readBoundedResponseBytes(response, 4)).rejects.toThrow(/exceeds.*limit/i);
		expect(cancelled).toBe(true);
	});

	it("rejects and cancels an oversized declared response before reading", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(body, { headers: { "content-length": "5" } });
		await expect(readBoundedResponseBytes(response, 4)).rejects.toThrow(/exceeds.*limit/i);
		expect(cancelled).toBe(true);
	});

	it("accepts a body exactly at the limit without Content-Length", async () => {
		const response = new Response(new Uint8Array([1, 2, 3, 4]));
		expect(await readBoundedResponseBytes(response, 4)).toEqual(Buffer.from([1, 2, 3, 4]));
	});
});

describe("skillAdd", () => {
	it("uploads a backend-valid skill_key generated from a long local directory name", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const longName = "a".repeat(240);
		const skillDir = join(tmpHome, longName);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: Long Skill\ndescription: long directory name\n---\n# Long\n",
		);

		const projectId = "00000000-0000-0000-0000-000000000099";
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/v1/agents/env-test/skills/sync/upload",
				response: (request) =>
					jsonResponse({
						skill_key: request.multipartFields?.skill_key,
						version: 1,
						file_count: 1,
					}),
			},
		]);
		try {
			await skillAdd(skillDir, { agent: "claude_code", yes: true });
		} finally {
			restore();
		}

		const upload = captured.find((c) => c.path === "/v1/agents/env-test/skills/sync/upload");
		expect(upload?.multipartFields?.skill_key).toHaveLength(200);
		expect(upload?.multipartFields?.skill_key).toBe("a".repeat(200));
		expect(existsSync(join(tmpHome, ".claude", "skills", "a".repeat(200), "SKILL.md"))).toBe(true);
		expect(
			readSkillProjectionState("claude_code", "env-test", projectId).claims.has("a".repeat(200)),
		).toBe(true);
	});

	it("does not create an Agent projection when the guarded local activation fails", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const skillDir = join(tmpHome, "reserved");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: Reserved\ndescription: guarded target\n---\n",
		);
		const target = join(tmpHome, ".claude", "skills", "reserved");
		reserveManagedSkill({
			targetDir: target,
			id: "reserved",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		const { captured, restore } = mockFetch([okEnvironmentProbe()]);
		try {
			await expect(skillAdd(skillDir, { agent: "claude_code", yes: true })).rejects.toThrow(
				/reserved by a managed Skill owner/,
			);
		} finally {
			restore();
		}
		expect(captured.some((request) => request.method === "POST")).toBe(false);
	});

	it("treats a local default Agent Project as filesystem-authoritative", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const skillDir = join(tmpHome, "default-agent");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: Default Agent\ndescription: local default target\n---\n",
		);
		const projectId = "00000000-0000-0000-0000-000000000099";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/projects/default",
				response: () => jsonResponse({ project_id: projectId }),
			},
			{
				method: "GET",
				path: `/v1/projects/${projectId}`,
				response: () =>
					jsonResponse({
						id: projectId,
						kind: "environment",
						origin_environment_id: "env-test",
					}),
			},
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/v1/agents/env-test/skills/sync/upload",
				response: () => jsonResponse({ skill_key: "default-agent", version: 1, file_count: 1 }),
			},
		]);
		try {
			await skillAdd(skillDir, { yes: true });
		} finally {
			restore();
		}
		expect(existsSync(join(tmpHome, ".claude", "skills", "default-agent", "SKILL.md"))).toBe(true);
		expect(captured.some((request) => request.path.includes("/skills/upload"))).toBe(false);
	});
});

describe("Agent-authoritative manual Skill mutations", () => {
	it("removes the guarded local target before deleting its projection", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const target = join(tmpHome, ".claude", "skills", "demo");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "# Demo\n");
		const projectId = "00000000-0000-0000-0000-000000000099";
		recordSkillProjectionClaim({
			agentType: "claude_code",
			agentId: "env-test",
			projectId,
			skillKey: "demo",
			hash: "claimed",
		});
		const { restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "DELETE",
				path: "/v1/agents/env-test/skills/sync/demo",
				response: () => {
					expect(existsSync(target)).toBe(false);
					return jsonResponse({ status: "deleted" });
				},
			},
		]);
		try {
			await skillRm("demo", { agent: "claude_code" });
		} finally {
			restore();
		}
		expect(readSkillProjectionState("claude_code", "env-test", projectId).claims.has("demo")).toBe(
			false,
		);
	});

	it("keeps deletion evidence when projection deletion is offline", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const target = join(tmpHome, ".claude", "skills", "demo");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "# Demo\n");
		const projectId = "00000000-0000-0000-0000-000000000099";
		recordSkillProjectionClaim({
			agentType: "claude_code",
			agentId: "env-test",
			projectId,
			skillKey: "demo",
			hash: "claimed",
		});
		const { restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "DELETE",
				path: "/v1/agents/env-test/skills/sync/demo",
				response: () => new Response("offline", { status: 503 }),
			},
		]);
		try {
			await expect(skillRm("demo", { agent: "claude_code" })).rejects.toThrow(/503/);
		} finally {
			restore();
		}
		expect(existsSync(target)).toBe(false);
		expect(readSkillProjectionState("claude_code", "env-test", projectId).claims.has("demo")).toBe(
			true,
		);
	});

	it("installs GitHub bytes locally before claiming the Agent projection", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const repositoryRoot = join(tmpHome, "demo-main");
		mkdirSync(repositoryRoot, { recursive: true });
		writeFileSync(
			join(repositoryRoot, "SKILL.md"),
			"---\nname: Demo\ndescription: fetched skill\n---\n",
		);
		const githubArchive = await tarSkillDir(repositoryRoot);
		const target = join(tmpHome, ".claude", "skills", "demo", "SKILL.md");
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "GET",
				path: "/owner/demo/tar.gz/HEAD",
				response: () => new Response(githubArchive),
			},
			{
				method: "POST",
				path: "/v1/agents/env-test/skills/sync/upload",
				response: () => {
					expect(existsSync(target)).toBe(true);
					return jsonResponse({
						skill_key: "demo",
						name: "Demo",
						version: 1,
						file_count: 1,
					});
				},
			},
		]);
		try {
			await skillInstall("owner/demo", { agent: "claude_code" });
		} finally {
			restore();
		}
		expect(captured.some((request) => request.path.includes("/skills/install"))).toBe(false);
	});

	it("does not project an Agent install when guarded local activation fails", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const repositoryRoot = join(tmpHome, "reserved-main");
		mkdirSync(repositoryRoot, { recursive: true });
		writeFileSync(
			join(repositoryRoot, "SKILL.md"),
			"---\nname: Reserved\ndescription: guarded install\n---\n",
		);
		const githubArchive = await tarSkillDir(repositoryRoot);
		reserveManagedSkill({
			targetDir: join(tmpHome, ".claude", "skills", "reserved"),
			id: "reserved",
			version: 1,
			digest: "b".repeat(64),
			manager: "local-setup",
		});
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "GET",
				path: "/owner/reserved/tar.gz/HEAD",
				response: () => new Response(githubArchive),
			},
		]);
		try {
			await expect(skillInstall("owner/reserved", { agent: "claude_code" })).rejects.toThrow(
				/reserved by a managed Skill owner/,
			);
		} finally {
			restore();
		}
		expect(captured.some((request) => request.method === "POST")).toBe(false);
	});

	it("routes a default local Agent Project through local-first install", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const repositoryRoot = join(tmpHome, "default-main");
		mkdirSync(repositoryRoot, { recursive: true });
		writeFileSync(
			join(repositoryRoot, "SKILL.md"),
			"---\nname: Default\ndescription: default agent install\n---\n",
		);
		const githubArchive = await tarSkillDir(repositoryRoot);
		const projectId = "00000000-0000-0000-0000-000000000099";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/projects/default",
				response: () => jsonResponse({ project_id: projectId }),
			},
			{
				method: "GET",
				path: `/v1/projects/${projectId}`,
				response: () =>
					jsonResponse({
						id: projectId,
						kind: "environment",
						origin_environment_id: "env-test",
					}),
			},
			okEnvironmentProbe(),
			{
				method: "GET",
				path: "/owner/default/tar.gz/HEAD",
				response: () => new Response(githubArchive),
			},
			{
				method: "POST",
				path: "/v1/agents/env-test/skills/sync/upload",
				response: () =>
					jsonResponse({ skill_key: "default", name: "Default", version: 1, file_count: 1 }),
			},
		]);
		try {
			await skillInstall("owner/default");
		} finally {
			restore();
		}
		expect(existsSync(join(tmpHome, ".claude", "skills", "default", "SKILL.md"))).toBe(true);
		expect(captured.some((request) => request.path.includes("/skills/install"))).toBe(false);
	});

	it("keeps an explicit workspace Project Cloud-owned", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const projectId = "00000000-0000-0000-0000-000000000088";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: `/v1/projects/${projectId}`,
				response: () =>
					jsonResponse({ id: projectId, kind: "workspace", origin_environment_id: null }),
			},
			{
				method: "POST",
				path: `/v1/projects/${projectId}/skills/install`,
				response: () =>
					jsonResponse({ skill_key: "demo", name: "Demo", version: 1, file_count: 1 }),
			},
		]);
		try {
			await skillInstall("owner/demo", { project: projectId });
		} finally {
			restore();
		}
		expect(captured.some((request) => request.path.includes("/skills/install"))).toBe(true);
		expect(captured.some((request) => request.path.includes("/skills/sync"))).toBe(false);
	});

	it("fails closed for an orphan Agent Project", async () => {
		seedAuthAndEnv(tmpHome, "claude_code");
		const projectId = "00000000-0000-0000-0000-000000000077";
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: `/v1/projects/${projectId}`,
				response: () =>
					jsonResponse({ id: projectId, kind: "environment", origin_environment_id: null }),
			},
		]);
		try {
			await expect(skillInstall("owner/demo", { project: projectId })).rejects.toThrow(
				/no longer has a live Agent identity/,
			);
		} finally {
			restore();
		}
		expect(captured.some((request) => request.method === "POST")).toBe(false);
	});
});
