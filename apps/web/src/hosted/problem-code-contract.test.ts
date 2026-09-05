import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import snapshotCodes from "@/hosted/lifecycle-problem-codes.snapshot.json";

/**
 * The lifecycle problem-code contract.
 *
 * `KnownLifecycleProblemCode` in clawdi-hosted
 * (`backend/app/v2/hosted/problem_registry.py`) is the sole factory for
 * deployment failure occurrences; the same code set is pinned as a JSON
 * snapshot in both repositories. CI goes red when either side drifts:
 *  - clawdi-hosted pytest asserts the enum equals its snapshot.
 *  - this test asserts the frontend never maps or emits a code outside the
 *    snapshot, and that the hosted smoke fixtures stay inside it.
 */

const SNAPSHOT = snapshotCodes as readonly string[];
const SNAPSHOT_SET = new Set(SNAPSHOT);

/** Client-side fallback code injected when a failure carries no code. */
const SYNTHETIC_FALLBACK_CODES = new Set(["operation_failed"]);

/** Code emitted by the provider connection-test surface, not a problem code. */
const SMOKE_NON_PROBLEM_CODES = new Set(["invalid_api_key"]);

const DEPLOYMENT_FAILURE_SOURCE = readFileSync(
	new URL("./deployment-failure.ts", import.meta.url),
	"utf8",
);
const HOSTED_SMOKE_SOURCE = readFileSync(
	new URL("../../e2e/hosted-smoke.pw.ts", import.meta.url),
	"utf8",
);

/**
 * Collect every pure snake_case string literal that appears in a `code:`
 * field (including ternary literals) or in a `*_CODES = new Set([...])`
 * membership set.
 */
function codeContextLiterals(source: string): string[] {
	const literals: string[] = [];
	for (const segment of source.matchAll(/\bcode:[^\n]*/g)) {
		literals.push(...snakeCaseLiterals(segment[0]));
	}
	for (const segment of source.matchAll(/[A-Za-z_]*CODES?\s*=\s*new Set\(\[([^\]]*)\]\)/g)) {
		literals.push(...snakeCaseLiterals(segment[0]));
	}
	return [...new Set(literals)];
}

function snakeCaseLiterals(text: string): string[] {
	return [...new Set([...text.matchAll(/["']([a-z_]+)["']/g)].map((match) => match[1]))];
}

describe("lifecycle problem-code snapshot", () => {
	test("is canonical and identical to the backend registry snapshot", () => {
		expect(SNAPSHOT.length).toBeGreaterThan(0);
		expect(new Set(SNAPSHOT).size).toBe(SNAPSHOT.length);
		expect([...SNAPSHOT]).toEqual([...SNAPSHOT].sort());
		expect(SNAPSHOT).toContain("runtime_readiness_timeout");
	});
});

describe("deployment-failure surface code contract", () => {
	test("every code the frontend maps or emits is inside the pinned snapshot", () => {
		const surfacedCodes = codeContextLiterals(DEPLOYMENT_FAILURE_SOURCE);
		for (const code of surfacedCodes) {
			expect(
				SNAPSHOT_SET.has(code) || SYNTHETIC_FALLBACK_CODES.has(code),
				`deployment-failure.ts keys on code "${code}" which the backend never emits`,
			).toBe(true);
		}
	});
});

describe("hosted smoke fixture problem-code contract", () => {
	test("every fixture problem code and problem URL stays inside the pinned snapshot", () => {
		const fixtureCodes = codeContextLiterals(HOSTED_SMOKE_SOURCE);
		for (const code of fixtureCodes) {
			expect(
				SNAPSHOT_SET.has(code) || SMOKE_NON_PROBLEM_CODES.has(code),
				`hosted-smoke.pw.ts uses problem code "${code}" outside the pinned set`,
			).toBe(true);
		}

		const problemUrlCodes = [
			...HOSTED_SMOKE_SOURCE.matchAll(/https:\/\/api\.clawdi\.ai\/problems\/([a-z0-9-]+)/g),
		].map((match) => match[1].replace(/-/g, "_"));
		for (const code of problemUrlCodes) {
			expect(
				SNAPSHOT_SET.has(code),
				`hosted-smoke.pw.ts problem URL refers to code "${code}" outside the pinned set`,
			).toBe(true);
		}
	});
});
