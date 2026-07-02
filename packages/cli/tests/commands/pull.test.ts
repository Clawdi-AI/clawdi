import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pull } from "../../src/commands/pull";
import { tarSkillDir } from "../../src/lib/tar";
import { cleanupTmp, copyFixtureToTmp } from "../adapters/helpers";
import {
	type AgentHomeOverrideSnapshot,
	jsonResponse,
	mockFetch,
	okEnvironmentProbe,
	restoreAgentHomeOverrides,
	seedAuthAndEnv,
	snapshotAndClearAgentHomeOverrides,
} from "./helpers";

const TEST_PROJECT_ID = "00000000-0000-0000-0000-000000000099";

type AgentKey = "claude-code" | "codex" | "hermes" | "openclaw";
const AGENT_TYPE: Record<AgentKey, string> = {
	"claude-code": "claude_code",
	codex: "codex",
	hermes: "hermes",
	openclaw: "openclaw",
};

let tmpHome: string;
let origHome: string | undefined;
let origHomeOverrides: AgentHomeOverrideSnapshot = {};

function setup(agent: AgentKey) {
	origHome = process.env.HOME;
	origHomeOverrides = snapshotAndClearAgentHomeOverrides();
	tmpHome = copyFixtureToTmp(agent);
	process.env.HOME = tmpHome;
	seedAuthAndEnv(tmpHome, AGENT_TYPE[agent]);
}

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	restoreAgentHomeOverrides(origHomeOverrides);
	origHomeOverrides = {};
	process.exitCode = 0;
	if (tmpHome) cleanupTmp(tmpHome);
});

/** Build a minimal tar.gz of a skill in a tmpdir, return the bytes. */
async function buildSkillTar(skillKey: string, skillMdContent: string): Promise<Buffer> {
	const tmp = join(tmpdir(), `skill-tar-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tmp, skillKey), { recursive: true });
	writeFileSync(join(tmp, skillKey, "SKILL.md"), skillMdContent);
	const bytes = await tarSkillDir(join(tmp, skillKey));
	rmSync(tmp, { recursive: true, force: true });
	return bytes;
}

describe("pull — Hermes fixture", () => {
	it("bounds cloud session pagination if the backend keeps returning full pages", async () => {
		setup("hermes");
		const page = Array.from({ length: 200 }, (_, index) => ({
			id: `session-${index}`,
			local_session_id: `local-${index}`,
			agent_type: "hermes",
			machine_name: "Test Mac",
			project_path: "/tmp/project",
			started_at: "2026-06-01T00:00:00.000Z",
			ended_at: null,
			message_count: 1,
			model: null,
			summary: null,
			content_hash: `hash-${index}`,
		}));
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/sessions",
				response: () => jsonResponse({ items: page, total: 100_000 }),
			},
		]);
		try {
			await expect(pull({ agent: "hermes", modules: "sessions" })).rejects.toThrow(
				"Too many session pages to pull safely.",
			);
		} finally {
			restore();
		}
		expect(captured.filter((request) => request.path.startsWith("/v1/sessions"))).toHaveLength(50);
	});

	it("downloads the cloud skill into $HOME/.hermes/skills/<key>/", async () => {
		setup("hermes");

		const tarBytes = await buildSkillTar(
			"demo",
			`---
name: demo
description: pulled from cloud
---
# demo
content
`,
		);

		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "GET",
				path: `/v1/projects/${TEST_PROJECT_ID}/skills/demo/download`,
				response: () => new Response(new Uint8Array(tarBytes), { status: 200 }),
			},
			{
				method: "GET",
				path: "/v1/skills",
				response: () => jsonResponse({ items: [{ skill_key: "demo", name: "demo" }] }),
			},
		]);

		try {
			await pull({ agent: "hermes", modules: "skills" });
		} finally {
			restore();
		}

		const skillMd = join(tmpHome, ".hermes", "skills", "demo", "SKILL.md");
		expect(existsSync(skillMd)).toBe(true);
		expect(readFileSync(skillMd, "utf-8")).toContain("description: pulled from cloud");

		// Both list + project-explicit download should have been called
		expect(captured.some((c) => c.path.startsWith("/v1/skills") && c.method === "GET")).toBe(true);
		expect(
			captured.some((c) => c.path === `/v1/projects/${TEST_PROJECT_ID}/skills/demo/download`),
		).toBe(true);
	});

	it("--dry-run fetches listing but does not download", async () => {
		setup("hermes");
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "GET",
				path: `/v1/projects/${TEST_PROJECT_ID}/skills/demo/download`,
				response: () => jsonResponse({}),
			},
			{
				method: "GET",
				path: "/v1/skills",
				response: () => jsonResponse({ items: [{ skill_key: "demo", name: "demo" }] }),
			},
		]);
		try {
			await pull({ agent: "hermes", modules: "skills", dryRun: true });
		} finally {
			restore();
		}

		// The list is needed to show the summary; the download must not fire.
		expect(captured.some((c) => c.path.startsWith("/v1/skills") && c.method === "GET")).toBe(true);
		expect(captured.some((c) => c.path.endsWith("/download"))).toBe(false);
		// Nothing written locally
		expect(existsSync(join(tmpHome, ".hermes", "skills", "demo", "SKILL.md"))).toBe(
			// Fixture already has core/demo/SKILL.md, not demo/SKILL.md — so false.
			false,
		);
	});

	it("cloud returns empty list → short-circuit", async () => {
		setup("hermes");
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{ method: "GET", path: "/v1/skills", response: () => jsonResponse({ items: [] }) },
		]);
		try {
			await pull({ agent: "hermes", modules: "skills" });
		} finally {
			restore();
		}
		expect(captured.some((c) => c.path.endsWith("/download"))).toBe(false);
	});

	it("aborts with exitCode=1 when not logged in (no fetch)", async () => {
		setup("hermes");
		rmSync(join(tmpHome, ".clawdi", "auth.json"));
		const { captured, restore } = mockFetch([]);
		try {
			await pull({ agent: "hermes", modules: "skills" });
		} finally {
			restore();
		}
		expect(captured).toHaveLength(0);
		expect(process.exitCode).toBe(1);
	});
});

describe("pull — Claude Code fixture", () => {
	it("downloads into $HOME/.claude/skills/<key>/", async () => {
		setup("claude-code");
		const tarBytes = await buildSkillTar(
			"fresh",
			`---
name: fresh
description: new
---
# fresh`,
		);
		const { restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "GET",
				path: `/v1/projects/${TEST_PROJECT_ID}/skills/fresh/download`,
				response: () => new Response(new Uint8Array(tarBytes), { status: 200 }),
			},
			{
				method: "GET",
				path: "/v1/skills",
				response: () => jsonResponse({ items: [{ skill_key: "fresh", name: "fresh" }] }),
			},
		]);
		try {
			await pull({ agent: "claude_code", modules: "skills" });
		} finally {
			restore();
		}
		expect(existsSync(join(tmpHome, ".claude", "skills", "fresh", "SKILL.md"))).toBe(true);
	});
});

describe("pull — Codex fixture", () => {
	it("downloads into $HOME/.codex/skills/<key>/", async () => {
		setup("codex");
		const tarBytes = await buildSkillTar(
			"fresh",
			`---
name: fresh
description: new
---
# fresh`,
		);
		const { restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "GET",
				path: `/v1/projects/${TEST_PROJECT_ID}/skills/fresh/download`,
				response: () => new Response(new Uint8Array(tarBytes), { status: 200 }),
			},
			{
				method: "GET",
				path: "/v1/skills",
				response: () => jsonResponse({ items: [{ skill_key: "fresh", name: "fresh" }] }),
			},
		]);
		try {
			await pull({ agent: "codex", modules: "skills" });
		} finally {
			restore();
		}
		expect(existsSync(join(tmpHome, ".codex", "skills", "fresh", "SKILL.md"))).toBe(true);
	});
});

describe("pull — OpenClaw fixture", () => {
	it("downloads into $HOME/.openclaw/agents/main/skills/<key>/", async () => {
		setup("openclaw");
		const tarBytes = await buildSkillTar(
			"fresh",
			`---
name: fresh
description: new
---
# fresh`,
		);
		const { restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "GET",
				path: `/v1/projects/${TEST_PROJECT_ID}/skills/fresh/download`,
				response: () => new Response(new Uint8Array(tarBytes), { status: 200 }),
			},
			{
				method: "GET",
				path: "/v1/skills",
				response: () => jsonResponse({ items: [{ skill_key: "fresh", name: "fresh" }] }),
			},
		]);
		try {
			await pull({ agent: "openclaw", modules: "skills" });
		} finally {
			restore();
		}
		expect(
			existsSync(join(tmpHome, ".openclaw", "agents", "main", "skills", "fresh", "SKILL.md")),
		).toBe(true);
	});
});
