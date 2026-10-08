/**
 * Round-35 P2 regression: lock writers mkdir parent dir on write.
 *
 * The daemon under env-only auth (`CLAWDI_AUTH_TOKEN`, no prior
 * `clawdi auth login`) on a fresh `$HOME` — typical hosted /
 * container path — may not have `~/.clawdi/` yet. Without the
 * mkdir-on-write the first successful upload's lock write threw
 * ENOENT, the queue recorded the already-uploaded item as
 * failed, and it got retried (or eventually evicted on
 * queue-cap pressure). Tests assert: when `~/.clawdi` is
 * missing, the writer creates it with restrictive mode AND the
 * lock file lands.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "clawdi-lock-test-"));
const originalHome = process.env.HOME;

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	const dir = mkdtempSync(join(tmp, "case-"));
	process.env.HOME = dir;
});

afterEach(() => {
	process.env.HOME = originalHome;
});

describe("writeSessionsLock", () => {
	it("creates ~/.clawdi when missing", async () => {
		const clawdiDir = join(process.env.HOME ?? "", ".clawdi");
		expect(existsSync(clawdiDir)).toBe(false);

		// Force the module to re-resolve HOME by importing inside the test.
		const { writeSessionsLock } = await import("./sessions-lock");
		writeSessionsLock({
			version: 2,
			sessions: {
				"v2:abc": {
					api_origin: "https://cloud.example",
					environment_id: "env",
					adapter: "claude_code",
					source_session_key: "abc",
					protocol: "snapshot-v1",
					local_hash: "x",
				},
			},
		});

		expect(existsSync(clawdiDir)).toBe(true);
		expect(existsSync(join(clawdiDir, "sessions-lock.json"))).toBe(true);
		// 0o700 on the dir matches the auth.json mode: a wide-open
		// home would let any local process read sync state.
		const mode = statSync(clawdiDir).mode & 0o777;
		expect(mode).toBe(0o700);
	});
});

describe("writeSkillsLock", () => {
	it("creates ~/.clawdi when missing", async () => {
		const clawdiDir = join(process.env.HOME ?? "", ".clawdi");
		expect(existsSync(clawdiDir)).toBe(false);

		const { writeSkillsLock } = await import("./skills-lock");
		writeSkillsLock({
			version: 5,
			skills: { "claude_code:foo": { hash: "x" } },
			claims: {},
			materializations: {},
		});

		expect(existsSync(clawdiDir)).toBe(true);
		expect(existsSync(join(clawdiDir, "skills-lock.json"))).toBe(true);
		const mode = statSync(clawdiDir).mode & 0o777;
		expect(mode).toBe(0o700);
	});
});
