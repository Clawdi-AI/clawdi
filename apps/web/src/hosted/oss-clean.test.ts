import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { IS_HOSTED } from "@/lib/hosted";

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
	return readdirSync(HOSTED_DIR)
		.filter((name) => name.endsWith(".tsx"))
		.map((name) => join(HOSTED_DIR, name));
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
		// At module load, NEXT_PUBLIC_CLAWDI_HOSTED is undefined in
		// `bun test` context unless explicitly set. So IS_HOSTED is
		// the OSS value: false.
		expect(IS_HOSTED).toBe(false);
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

describe("non-hosted callers gate hosted/ usage behind IS_HOSTED", () => {
	test("any non-hosted file importing @/hosted/* references IS_HOSTED", () => {
		const callers: string[] = [];
		for (const file of walkSrcExceptHosted(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			if (/from\s+["']@\/hosted\/[^"']+["']/.test(src)) {
				callers.push(file);
			}
		}
		// Sanity: at least the known consumers (app-sidebar, dashboard page)
		// should show up. If this drops to 0 the test is broken, not the code.
		expect(callers.length).toBeGreaterThan(0);

		for (const caller of callers) {
			const src = readFileSync(caller, "utf8");
			const usesFlag = /\bIS_HOSTED\b/.test(src);
			if (!usesFlag) {
				const rel = relative(SRC_DIR, caller);
				throw new Error(
					`${rel} imports from @/hosted/* but never references IS_HOSTED — gate the JSX usage or pass {enabled: IS_HOSTED} to hooks.`,
				);
			}
		}
	});
});

describe("app-sidebar gates DeployTrigger behind IS_HOSTED", () => {
	test("rendering of DeployTrigger is guarded by IS_HOSTED", () => {
		const sidebar = readFileSync(
			join(import.meta.dir, "..", "components", "app-sidebar.tsx"),
			"utf8",
		);
		// Any JSX usage of <DeployTrigger /> must be preceded by
		// `IS_HOSTED && ` in the same expression.
		const guarded = /IS_HOSTED\s*&&\s*<DeployTrigger\b/.test(sidebar);
		expect(guarded).toBe(true);
	});
});
