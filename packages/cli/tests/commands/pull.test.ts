import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pull } from "../../src/commands/pull";
import { tarSkillDir } from "../../src/lib/tar";
import { cleanupTmp, copyFixtureToTmp } from "../adapters/helpers";
import { jsonResponse, mockFetch, okEnvironmentProbe, seedAuthAndEnv } from "./helpers";

const TEST_SCOPE_ID = "00000000-0000-0000-0000-000000000099";

type AgentKey = "claude-code" | "codex" | "hermes" | "openclaw";
const AGENT_TYPE: Record<AgentKey, string> = {
	"claude-code": "claude_code",
	codex: "codex",
	hermes: "hermes",
	openclaw: "openclaw",
};

let tmpHome: string;
let origHome: string | undefined;

function setup(agent: AgentKey) {
	origHome = process.env.HOME;
	tmpHome = copyFixtureToTmp(agent);
	process.env.HOME = tmpHome;
	seedAuthAndEnv(tmpHome, AGENT_TYPE[agent]);
}

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
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
				path: `/api/scopes/${TEST_SCOPE_ID}/skills/demo/download`,
				response: () => new Response(new Uint8Array(tarBytes), { status: 200 }),
			},
			{
				method: "GET",
				path: "/api/skills",
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

		// Both list + scoped download should have been called
		expect(captured.some((c) => c.path.startsWith("/api/skills") && c.method === "GET")).toBe(true);
		expect(
			captured.some((c) => c.path === `/api/scopes/${TEST_SCOPE_ID}/skills/demo/download`),
		).toBe(true);
	});

	it("--dry-run fetches listing but does not download", async () => {
		setup("hermes");
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "GET",
				path: `/api/scopes/${TEST_SCOPE_ID}/skills/demo/download`,
				response: () => jsonResponse({}),
			},
			{
				method: "GET",
				path: "/api/skills",
				response: () => jsonResponse({ items: [{ skill_key: "demo", name: "demo" }] }),
			},
		]);
		try {
			await pull({ agent: "hermes", modules: "skills", dryRun: true });
		} finally {
			restore();
		}

		// The list is needed to show the summary; the download must not fire.
		expect(captured.some((c) => c.path.startsWith("/api/skills") && c.method === "GET")).toBe(true);
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
			{ method: "GET", path: "/api/skills", response: () => jsonResponse({ items: [] }) },
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
				path: `/api/scopes/${TEST_SCOPE_ID}/skills/fresh/download`,
				response: () => new Response(new Uint8Array(tarBytes), { status: 200 }),
			},
			{
				method: "GET",
				path: "/api/skills",
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
				path: `/api/scopes/${TEST_SCOPE_ID}/skills/fresh/download`,
				response: () => new Response(new Uint8Array(tarBytes), { status: 200 }),
			},
			{
				method: "GET",
				path: "/api/skills",
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
				path: `/api/scopes/${TEST_SCOPE_ID}/skills/fresh/download`,
				response: () => new Response(new Uint8Array(tarBytes), { status: 200 }),
			},
			{
				method: "GET",
				path: "/api/skills",
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
