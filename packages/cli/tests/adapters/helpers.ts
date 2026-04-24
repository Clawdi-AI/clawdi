import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "fixtures");

/**
 * Copy a fixture HOME to a fresh tmpdir and return the tmpdir path.
 *
 * Tests should set `process.env.HOME = tmpHome` immediately after calling
 * this — lib/config.ts and adapters/paths.ts read $HOME lazily on every call.
 */
export function copyFixtureToTmp(agent: "claude-code" | "codex" | "hermes" | "openclaw"): string {
	const src = join(fixturesRoot, agent);
	const dst = join(
		tmpdir(),
		`clawdi-fixture-${agent}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dst, { recursive: true });
	cpSync(src, dst, { recursive: true });
	return dst;
}

export function cleanupTmp(tmp: string) {
	rmSync(tmp, { recursive: true, force: true });
}
