import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * OSS-clean invariant tests.
 *
 * The hosted/ directory must stay quarantined: every component
 * inside it sets `data-hosted="true"` on its root element, and
 * every consumer outside hosted/ is gated by `IS_HOSTED` somewhere
 * in the same file.
 *
 * Static regex / file-walk checks instead of React render tests —
 * apps/web has no jsdom / @testing-library setup and adding it for
 * one invariant would be overkill. The static gates catch the
 * failure modes that matter: forgetting `data-hosted`, forgetting
 * the IS_HOSTED guard when importing hosted modules.
 */

const HOSTED_DIR = join(import.meta.dir);
const SRC_DIR = join(import.meta.dir, "..");

function listHostedTsx(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const st = statSync(full);
			if (st.isDirectory()) walk(full);
			else if (entry.endsWith(".tsx")) out.push(full);
		}
	};
	walk(HOSTED_DIR);
	return out;
}

function walkSrcExceptHosted(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (full === HOSTED_DIR) continue;
			walkSrcExceptHosted(full, out);
		} else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
			out.push(full);
		}
	}
	return out;
}

describe("IS_HOSTED flag", () => {
	test("defaults to false when env var is unset", () => {
		const env = { ...process.env };
		delete env.NEXT_PUBLIC_CLAWDI_HOSTED;
		env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= "pk_test_dummy_for_unit_tests";

		const result = spawnSync(
			process.execPath,
			["-e", 'import { IS_HOSTED } from "../lib/hosted"; console.log(String(IS_HOSTED));'],
			{ cwd: HOSTED_DIR, env, encoding: "utf8" },
		);

		if (result.status !== 0) {
			throw new Error(result.stderr || "failed to import hosted flag in subprocess");
		}

		expect(result.stdout.trim()).toBe("false");
	});
});

describe("hosted/ directory invariants", () => {
	test('every .tsx file sets data-hosted="true" on its root', () => {
		const files = listHostedTsx();
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const src = readFileSync(file, "utf8");
			// Tight match: explicit `data-hosted="true"` or `data-hosted={"true"}`.
			// Rejects `data-hosted="false"`, typos, and arbitrary expression forms
			// that would slip past the original looser pattern.
			const hasDataHosted = /\bdata-hosted=(?:"true"|\{"true"\})/.test(src);
			expect(hasDataHosted).toBe(true);
		}
	});
});

describe("no static @/hosted/* imports outside hosted/", () => {
	test("non-hosted files only reach hosted/ via dynamic imports", () => {
		// Static imports of `@/hosted/*` from any OSS-reachable file
		// would pull the hosted chunk into the OSS main bundle even
		// when the runtime usage is gated by `IS_HOSTED`. The fix is
		// always `dynamic(() => import("@/hosted/…"))` constructed
		// inside an `IS_HOSTED ? … : null` ternary so the OSS bundler
		// statically eliminates the import() site. This test fails if
		// anyone re-introduces a static `from "@/hosted/…"` import.
		const offenders: string[] = [];
		for (const file of walkSrcExceptHosted(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			// Match top-of-file `import … from "@/hosted/…"` — `dynamic`
			// arrow-callbacks use `import("…")` (no `from` keyword).
			if (/^\s*import\s+[^"']+from\s+["']@\/hosted\//m.test(src)) {
				offenders.push(relative(SRC_DIR, file));
			}
		}
		if (offenders.length > 0) {
			throw new Error(
				`Static @/hosted/* imports leak the hosted chunk into OSS bundles:\n  ${offenders.join("\n  ")}\nUse dynamic imports gated on IS_HOSTED instead.`,
			);
		}
	});
});

describe("app-sidebar dynamically loads DeployTrigger only when hosted", () => {
	test("DeployTrigger constructor is gated by IS_HOSTED at module level", () => {
		const sidebar = readFileSync(
			join(import.meta.dir, "..", "components", "app-sidebar.tsx"),
			"utf8",
		);
		// Module-level dynamic import must be wrapped in an `IS_HOSTED ?
		// dynamic(…) : null` ternary so the OSS build's bundler
		// statically eliminates the import() call (and therefore the
		// hosted chunk). A bare `dynamic(() => import("@/hosted/…"))`
		// at module top level would still register the chunk in OSS
		// builds, defeating the point.
		const gatedAtConstruction = /const\s+DeployTrigger\s*=\s*IS_HOSTED\s*\?\s*dynamic\s*\(/.test(
			sidebar,
		);
		expect(gatedAtConstruction).toBe(true);
	});
});
