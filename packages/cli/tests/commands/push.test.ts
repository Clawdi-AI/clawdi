import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { push } from "../../src/commands/push";
import { cleanupTmp, copyFixtureToTmp } from "../adapters/helpers";
import {
	type AgentHomeOverrideSnapshot,
	type CapturedRequest,
	jsonResponse,
	mockFetch,
	okEnvironmentProbe,
	restoreAgentHomeOverrides,
	seedAuthAndEnv,
	snapshotAndClearAgentHomeOverrides,
} from "./helpers";

/** Narrow the JSON-parsed request body of `/api/sessions/batch`. */
interface BatchSession {
	environment_id: string;
	local_session_id: string;
	input_tokens?: number;
	cache_read_tokens?: number;
	project_path?: string | null;
}
function batchSessions(c: CapturedRequest | undefined): BatchSession[] {
	const body = c?.body as { sessions?: BatchSession[] } | undefined;
	return body?.sessions ?? [];
}

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

function setup(agent: AgentKey): {
	sent: ReturnType<typeof mockFetch>["captured"];
	restore: () => void;
} {
	origHome = process.env.HOME;
	origHomeOverrides = snapshotAndClearAgentHomeOverrides();
	tmpHome = copyFixtureToTmp(agent);
	process.env.HOME = tmpHome;
	seedAuthAndEnv(tmpHome, AGENT_TYPE[agent]);
	return { sent: [], restore: () => {} };
}

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	restoreAgentHomeOverrides(origHomeOverrides);
	origHomeOverrides = {};
	// `push` sets `process.exitCode = 1` on abort paths (not logged in,
	// no env). Reset to 0 so subsequent test files start clean —
	// `bun test` (1.3.13+) inherits the file's final exitCode.
	process.exitCode = 0;
	if (tmpHome) cleanupTmp(tmpHome);
});

describe("push — Hermes fixture", () => {
	it("uploads session metadata in bounded batches", async () => {
		setup("hermes");
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/api/sessions/batch",
				response: () =>
					jsonResponse({
						created: 0,
						updated: 0,
						unchanged: 0,
						needs_content: [],
					}),
			},
			{ method: "POST", path: "/api/sessions/", response: () => jsonResponse({}) },
		]);

		try {
			await push({ agent: "hermes", modules: "sessions", all: true });
		} finally {
			restore();
		}

		const batchCalls = captured.filter((c) => c.path === "/api/sessions/batch");
		expect(batchCalls.length).toBeGreaterThan(0);
		for (const call of batchCalls) expect(call.method).toBe("POST");
		const chunkSizes = batchCalls.map((call) => batchSessions(call).length);
		expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(500);
		// environment_id was seeded via seedAuthAndEnv
		expect(batchCalls.flatMap(batchSessions).every((s) => s.environment_id === "env-test")).toBe(
			true,
		);

		// `needs_content` is empty in this test's mock responses.
		const uploads = captured.filter((c) => c.path.match(/^\/api\/sessions\/[^/]+\/upload$/));
		expect(uploads).toHaveLength(0);

		// state.json updated. Round 1 (commit d8122d6) switched the cursor
		// key from global `sessions` to per-agent `sessions:<agentType>` so
		// pushing one agent doesn't advance another agent's cursor.
		const state = JSON.parse(readFileSync(join(tmpHome, ".clawdi", "state.json"), "utf-8"));
		expect(state["sessions:hermes"]?.lastActivityAt).toBeDefined();
	});

	it("--dry-run makes zero fetch calls", async () => {
		setup("hermes");
		const { captured, restore } = mockFetch([]);
		try {
			await push({ agent: "hermes", modules: "sessions", all: true, dryRun: true });
		} finally {
			restore();
		}
		expect(captured).toHaveLength(0);
	});

	it("skills module uploads multipart per skill", async () => {
		setup("hermes");
		const projectId = "00000000-0000-0000-0000-000000000099";
		const { captured, restore } = mockFetch([
			// `okEnvironmentProbe` returns `default_project_id =
			// "00000000-...-099"` by default; the upload mock below
			// pins the URL to that same project. Push now reads the
			// project from the agent's env, not from
			// `/api/projects/default`, so multi-agent users land
			// under their own env's project.
			okEnvironmentProbe(),
			{
				method: "POST",
				path: `/api/projects/${projectId}/skills/upload`,
				response: () => jsonResponse({ skill_key: "core/demo", version: 1, file_count: 1 }),
			},
		]);
		try {
			await push({ agent: "hermes", modules: "skills", all: true });
		} finally {
			restore();
		}
		const uploads = captured.filter((c) => c.path === `/api/projects/${projectId}/skills/upload`);
		expect(uploads.length).toBeGreaterThan(0);
		for (const upload of uploads) expect(upload.isMultipart).toBe(true);
	});

	it("skips local skills with invalid skill_keys before upload", async () => {
		setup("hermes");
		const invalidDir = join(tmpHome, ".hermes", "skills", "core", "bad skill");
		mkdirSync(invalidDir, { recursive: true });
		writeFileSync(
			join(invalidDir, "SKILL.md"),
			"---\nname: Bad Skill\ndescription: invalid local directory name\n---\n# Bad\n",
		);

		const projectId = "00000000-0000-0000-0000-000000000099";
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: `/api/projects/${projectId}/skills/upload`,
				response: () => jsonResponse({ skill_key: "core/demo", version: 1, file_count: 1 }),
			},
		]);
		try {
			await push({ agent: "hermes", modules: "skills", all: true });
		} finally {
			restore();
		}

		const uploads = captured.filter((c) => c.path === `/api/projects/${projectId}/skills/upload`);
		expect(uploads).toHaveLength(1);
	});

	it("a skill already in the skills-lock is skipped on the next push", async () => {
		setup("hermes");
		const projectId = "00000000-0000-0000-0000-000000000099";
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: `/api/projects/${projectId}/skills/upload`,
				response: () => jsonResponse({ skill_key: "core/demo", version: 1, file_count: 1 }),
			},
		]);
		const uploadCount = () =>
			captured.filter((c) => c.path === `/api/projects/${projectId}/skills/upload`).length;
		try {
			// First push computes the skill's folder hash, uploads it, and
			// records the hash in the skills-lock.
			await push({ agent: "hermes", modules: "skills", all: true });
			expect(uploadCount()).toBe(1);

			// Second push: the skill is unchanged, so the scan-phase hash
			// matches the skills-lock entry — it must NOT upload again.
			await push({ agent: "hermes", modules: "skills", all: true });
			expect(uploadCount()).toBe(1);
		} finally {
			restore();
		}
	});

	it("corrupt state.json is tolerated (warning, not crash)", async () => {
		setup("hermes");
		writeFileSync(join(tmpHome, ".clawdi", "state.json"), "{ not valid json");
		const { restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/api/sessions/batch",
				response: () =>
					jsonResponse({
						created: 2,
						updated: 0,
						unchanged: 0,
						needs_content: ["s-json", "s-plain"],
					}),
			},
			{ method: "POST", path: "/api/sessions/", response: () => jsonResponse({}) },
		]);
		try {
			await push({ agent: "hermes", modules: "sessions", all: true });
		} finally {
			restore();
		}
		// Got here without throwing.
		expect(existsSync(join(tmpHome, ".clawdi", "state.json"))).toBe(true);
	});
});

describe("push — Claude Code fixture", () => {
	it("uploads the single fixture session", async () => {
		setup("claude-code");
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/api/sessions/batch",
				response: () => jsonResponse({ created: 1, updated: 0, unchanged: 0, needs_content: [] }),
			},
			{ method: "POST", path: "/api/sessions/", response: () => jsonResponse({}) },
		]);
		try {
			await push({ agent: "claude_code", modules: "sessions", all: true });
		} finally {
			restore();
		}

		const batch = captured.find((c) => c.path === "/api/sessions/batch");
		expect(batch).toBeDefined();
		const sessions = batchSessions(batch);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.local_session_id).toBe("11111111-2222-3333-4444-555555555555");
		expect(sessions[0]?.input_tokens).toBe(30);
		expect(sessions[0]?.output_tokens).toBe(8);
		expect(sessions[0]?.project_path).toBe("/Users/fixture/project");
	});
});

describe("push — Codex fixture", () => {
	it("uploads the single fixture session with Codex token counters", async () => {
		setup("codex");
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/api/sessions/batch",
				response: () => jsonResponse({ created: 1, updated: 0, unchanged: 0, needs_content: [] }),
			},
			{ method: "POST", path: "/api/sessions/", response: () => jsonResponse({}) },
		]);
		try {
			await push({ agent: "codex", modules: "sessions", all: true });
		} finally {
			restore();
		}

		const batch = captured.find((c) => c.path === "/api/sessions/batch");
		const sessions = batchSessions(batch);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.input_tokens).toBe(15);
		expect(sessions[0]?.output_tokens).toBe(7);
		expect(sessions[0]?.cache_read_tokens).toBe(3);
		expect(sessions[0]?.model).toBe("gpt-5.3-codex");
	});
});

describe("push — OpenClaw fixture", () => {
	it("uploads the single fixture session with OpenClaw tokens + cwd", async () => {
		setup("openclaw");
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/api/sessions/batch",
				response: () => jsonResponse({ created: 1, updated: 0, unchanged: 0, needs_content: [] }),
			},
			{ method: "POST", path: "/api/sessions/", response: () => jsonResponse({}) },
		]);
		try {
			await push({ agent: "openclaw", modules: "sessions", all: true });
		} finally {
			restore();
		}

		const batch = captured.find((c) => c.path === "/api/sessions/batch");
		const sessions = batchSessions(batch);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.local_session_id).toBe("oc-session-001");
		expect(sessions[0]?.project_path).toBe("/Users/fixture/project");
		expect(sessions[0]?.input_tokens).toBe(12);
	});
});

describe("push — env_id probe (Codex plan A)", () => {
	it("aborts with exitCode=1 when cached env_id 404s", async () => {
		setup("hermes");
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/api/environments/env-test",
				response: () => new Response("", { status: 404 }),
			},
		]);
		try {
			await push({ agent: "hermes", modules: "sessions", all: true });
		} finally {
			restore();
		}
		expect(process.exitCode).toBe(1);
		// No batch upload — we bailed before doing any work.
		expect(captured.find((c) => c.path === "/api/sessions/batch")).toBeUndefined();
	});

	it("aborts on 400 unknown_environment from batch endpoint (race after probe)", async () => {
		setup("hermes");
		const { restore } = mockFetch([
			okEnvironmentProbe(), // probe succeeds…
			{
				// …but a parallel teardown could delete the env between probe and
				// batch. The CLI must catch the structured 400 the same way.
				method: "POST",
				path: "/api/sessions/batch",
				response: () =>
					jsonResponse(
						{
							detail: {
								code: "unknown_environment",
								message: "Run `clawdi setup`",
								environment_ids: ["env-test"],
							},
						},
						400,
					),
			},
		]);
		try {
			await push({ agent: "hermes", modules: "sessions", all: true });
		} finally {
			restore();
		}
		expect(process.exitCode).toBe(1);
	});
});

describe("push — preflight checks", () => {
	it("aborts with exitCode=1 when not logged in (no fetch)", async () => {
		setup("hermes");
		const { rmSync } = await import("node:fs");
		rmSync(join(tmpHome, ".clawdi", "auth.json"));

		const { captured, restore } = mockFetch([]);
		try {
			await push({ agent: "hermes", modules: "sessions", all: true });
		} finally {
			restore();
		}
		expect(captured).toHaveLength(0);
		expect(process.exitCode).toBe(1);
	});

	it("aborts with exitCode=1 when no environment registered (no fetch)", async () => {
		setup("hermes");
		const { rmSync } = await import("node:fs");
		rmSync(join(tmpHome, ".clawdi", "environments", "hermes.json"));

		const { captured, restore } = mockFetch([]);
		try {
			await push({ agent: "hermes", modules: "sessions", all: true });
		} finally {
			restore();
		}
		expect(captured).toHaveLength(0);
		expect(process.exitCode).toBe(1);
	});
});

describe("push — --all flag fan-out", () => {
	it("--all + explicit --agent narrows to that agent (explicit wins)", async () => {
		setup("claude-code");
		// Seed a second env so the only way "claude_code" gets selected
		// is if the explicit --agent flag overrides --all's broadening.
		writeFileSync(
			join(tmpHome, ".clawdi", "environments", "codex.json"),
			JSON.stringify({ id: "env-codex", agentType: "codex" }),
		);
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/api/sessions/batch",
				response: () => jsonResponse({ created: 1, updated: 0, unchanged: 0, needs_content: [] }),
			},
		]);
		try {
			await push({ agent: "claude_code", modules: "sessions", all: true });
		} finally {
			restore();
		}
		// One batch call with the claude_code session — codex was NOT
		// pulled in despite --all, because --agent narrowed.
		const batches = captured.filter((c) => c.path === "/api/sessions/batch");
		expect(batches).toHaveLength(1);
		const sessions = batchSessions(batches[0]);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.local_session_id).toBe("11111111-2222-3333-4444-555555555555");
	});

	it("--all + --project narrows project (silent-precedence bug fix)", async () => {
		setup("claude-code");
		const { captured, restore } = mockFetch([okEnvironmentProbe()]);
		try {
			// Project that no fixture session lives in. Old behavior:
			// --all silently overrode --project and the lone fixture
			// session got uploaded anyway. New behavior: --project
			// narrows to a non-matching path, batch gets zero sessions,
			// no upload.
			await push({
				agent: "claude_code",
				modules: "sessions",
				all: true,
				project: "/Users/no-such-project",
			});
		} finally {
			restore();
		}
		expect(captured.find((c) => c.path === "/api/sessions/batch")).toBeUndefined();
	});

	it("--all alone reaches all axes for a single registered agent", async () => {
		setup("claude-code");
		const projectId = "00000000-0000-0000-0000-000000000099";
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/api/sessions/batch",
				response: () => jsonResponse({ created: 1, updated: 0, unchanged: 0, needs_content: [] }),
			},
			{
				method: "POST",
				path: `/api/projects/${projectId}/skills/upload`,
				response: () => jsonResponse({ skill_key: "demo", version: 1, file_count: 1 }),
			},
		]);
		try {
			// No --modules, no --agent, no --project — just --all.
			// Should reach both modules: the fixture session via batch,
			// and the fixture skills via the skills/upload endpoint.
			await push({ all: true });
		} finally {
			restore();
		}
		const batch = captured.find((c) => c.path === "/api/sessions/batch");
		expect(batch).toBeDefined();
		expect(batchSessions(batch)).toHaveLength(1);
		// Skill axis was also exercised — proves --all defaults modules
		// to the full set when --modules isn't passed.
		const skillUploads = captured.filter(
			(c) => c.path === `/api/projects/${projectId}/skills/upload`,
		);
		expect(skillUploads.length).toBeGreaterThan(0);
	});

	it("multi-agent push scans every agent then uploads (scan/upload split)", async () => {
		setup("claude-code");
		// Two registered agents. The claude-code fixture only has
		// claude_code session data; codex has an env file but no
		// session dir — it scans empty. The push must still iterate
		// both agents (scan phase) and upload the one with data,
		// without the codex empty-scan aborting the run.
		writeFileSync(
			join(tmpHome, ".clawdi", "environments", "codex.json"),
			JSON.stringify({ id: "env-codex", agentType: "codex" }),
		);
		const { captured, restore } = mockFetch([
			okEnvironmentProbe("env-test"),
			okEnvironmentProbe("env-codex"),
			{
				method: "POST",
				path: "/api/sessions/batch",
				response: () => jsonResponse({ created: 1, updated: 0, unchanged: 0, needs_content: [] }),
			},
		]);
		try {
			await push({ modules: "sessions", all: true });
		} finally {
			restore();
		}
		// Both env probes happened — proof the scan phase visited both
		// agents before any upload.
		expect(captured.some((c) => c.path === "/api/environments/env-test")).toBe(true);
		expect(captured.some((c) => c.path === "/api/environments/env-codex")).toBe(true);
		// claude_code's session uploaded; codex contributed nothing but
		// didn't abort the run.
		const batches = captured.filter((c) => c.path === "/api/sessions/batch");
		expect(batches).toHaveLength(1);
		expect(batchSessions(batches[0])).toHaveLength(1);
	});
});
