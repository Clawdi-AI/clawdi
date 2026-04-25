import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { push } from "../../src/commands/push";
import { cleanupTmp, copyFixtureToTmp } from "../adapters/helpers";
import {
	type CapturedRequest,
	jsonResponse,
	mockFetch,
	okEnvironmentProbe,
	seedAuthAndEnv,
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

function setup(agent: AgentKey): {
	sent: ReturnType<typeof mockFetch>["captured"];
	restore: () => void;
} {
	origHome = process.env.HOME;
	tmpHome = copyFixtureToTmp(agent);
	process.env.HOME = tmpHome;
	seedAuthAndEnv(tmpHome, AGENT_TYPE[agent]);
	return { sent: [], restore: () => {} };
}

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	// `push` sets `process.exitCode = 1` on abort paths (not logged in,
	// no env). Reset to 0 so subsequent test files start clean —
	// `bun test` (1.3.13+) inherits the file's final exitCode.
	process.exitCode = 0;
	if (tmpHome) cleanupTmp(tmpHome);
});

describe("push — Hermes fixture", () => {
	it("uploads the 2 non-empty sessions plus per-session content", async () => {
		setup("hermes");
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{ method: "POST", path: "/api/sessions/batch", response: () => jsonResponse({ synced: 2 }) },
			{ method: "POST", path: "/api/sessions/", response: () => jsonResponse({}) },
		]);

		try {
			await push({ agent: "hermes", modules: "sessions", all: true });
		} finally {
			restore();
		}

		const batchCall = captured.find((c) => c.path === "/api/sessions/batch");
		expect(batchCall).toBeDefined();
		expect(batchCall?.method).toBe("POST");
		// Adapter filters out s-empty; s-json comes first by started_at DESC.
		const sessions = batchSessions(batchCall);
		expect(sessions).toHaveLength(2);
		expect(sessions.map((s) => s.local_session_id).sort()).toEqual(["s-json", "s-plain"]);
		// environment_id was seeded via seedAuthAndEnv
		expect(sessions[0]?.environment_id).toBe("env-test");

		// After batch, each session gets a content upload (multipart).
		const uploads = captured.filter((c) => c.path.match(/^\/api\/sessions\/[^/]+\/upload$/));
		expect(uploads).toHaveLength(2);
		for (const u of uploads) expect(u.isMultipart).toBe(true);

		// state.json updated
		const state = JSON.parse(readFileSync(join(tmpHome, ".clawdi", "state.json"), "utf-8"));
		expect(state.sessions.lastActivityAt).toBeDefined();
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
		const { captured, restore } = mockFetch([
			okEnvironmentProbe(),
			{
				method: "POST",
				path: "/api/skills/upload",
				response: () => jsonResponse({ skill_key: "core/demo", version: 1, file_count: 1 }),
			},
		]);
		try {
			await push({ agent: "hermes", modules: "skills", all: true });
		} finally {
			restore();
		}
		const uploads = captured.filter((c) => c.path === "/api/skills/upload");
		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.isMultipart).toBe(true);
	});

	it("corrupt state.json is tolerated (warning, not crash)", async () => {
		setup("hermes");
		writeFileSync(join(tmpHome, ".clawdi", "state.json"), "{ not valid json");
		const { restore } = mockFetch([
			okEnvironmentProbe(),
			{ method: "POST", path: "/api/sessions/batch", response: () => jsonResponse({ synced: 2 }) },
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
			{ method: "POST", path: "/api/sessions/batch", response: () => jsonResponse({ synced: 1 }) },
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
			{ method: "POST", path: "/api/sessions/batch", response: () => jsonResponse({ synced: 1 }) },
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
			{ method: "POST", path: "/api/sessions/batch", response: () => jsonResponse({ synced: 1 }) },
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
