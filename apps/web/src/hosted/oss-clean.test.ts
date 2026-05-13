import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

// Strip JS/TS comments (`// …` line and `/* … */` block) before
// checking the source. JSX attributes never live inside comments,
// so this prevents marker-in-JSDoc from accidentally satisfying the
// `data-hosted` invariant — a real DOM attribute is required.
function stripComments(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const n = src[i + 1];
		if (c === "/" && n === "/") {
			i += 2;
			while (i < src.length && src[i] !== "\n") i++;
		} else if (c === "/" && n === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
		} else if (c === '"' || c === "'" || c === "`") {
			out += c;
			i++;
			while (i < src.length && src[i] !== c) {
				if (src[i] === "\\") {
					out += src[i] + (src[i + 1] ?? "");
					i += 2;
				} else {
					out += src[i];
					i++;
				}
			}
			out += src[i] ?? "";
			i++;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

function findMatchingBrace(src: string, openBraceIndex: number): number {
	let depth = 0;
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let inTemplate = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = openBraceIndex; i < src.length; i++) {
		const c = src[i];
		const n = src[i + 1];

		if (inLineComment) {
			if (c === "\n") inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (c === "*" && n === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inSingleQuote) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === "'") inSingleQuote = false;
			continue;
		}
		if (inDoubleQuote) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === '"') inDoubleQuote = false;
			continue;
		}
		if (inTemplate) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === "`") inTemplate = false;
			continue;
		}

		if (c === "/" && n === "/") {
			inLineComment = true;
			i++;
			continue;
		}
		if (c === "/" && n === "*") {
			inBlockComment = true;
			i++;
			continue;
		}
		if (c === "'") {
			inSingleQuote = true;
			continue;
		}
		if (c === '"') {
			inDoubleQuote = true;
			continue;
		}
		if (c === "`") {
			inTemplate = true;
			continue;
		}

		if (c === "{") {
			depth++;
			continue;
		}
		if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}

	return -1;
}

describe("hosted/ directory invariants", () => {
	test('every .tsx file sets data-hosted="true" on its root', () => {
		const files = listHostedTsx();
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const src = stripComments(readFileSync(file, "utf8"));
			// Tight match: explicit `data-hosted="true"` or `data-hosted={"true"}`.
			// Rejects `data-hosted="false"`, typos, and arbitrary expression forms
			// that would slip past the original looser pattern. Source has had
			// comments stripped so a JSDoc reference to `data-hosted="true"`
			// can no longer satisfy the invariant — a real JSX attribute is
			// required.
			const hasDataHosted = /\bdata-hosted=(?:"true"|\{"true"\})/.test(src);
			if (!hasDataHosted) {
				throw new Error(
					`${relative(SRC_DIR, file)}: hosted .tsx must set data-hosted="true" on its rendered root`,
				);
			}
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

describe("dynamic @/hosted/* imports are gated by IS_HOSTED", () => {
	test('every `dynamic(import("@/hosted/…"))` is constructed inside `IS_HOSTED ? … : null`', () => {
		// Why this matters: a bare `dynamic(() => import("@/hosted/x"))`
		// at module top level would register the hosted chunk in the OSS
		// build's webpack/turbopack manifest even though `IS_HOSTED &&
		// <Component />` keeps it from rendering. The runtime bundler
		// only eliminates the import() call when the surrounding
		// expression is provably unreachable — `IS_HOSTED ? dynamic(…)
		// : null` collapses to `null` at build time once
		// `NEXT_PUBLIC_CLAWDI_HOSTED` is folded in, taking the entire
		// import() with it.
		const offenders: string[] = [];
		// Anchor on each `dynamic(() => import("@/hosted/…"))` call,
		// then walk backwards to the most recent `const ` keyword. The
		// snippet between the two must contain `IS_HOSTED ?` — that's
		// the gate the bundler folds at build time.
		const hostedDynamic = /dynamic\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*["']@\/hosted\/[^"']+["']/g;
		for (const file of walkSrcExceptHosted(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			for (const match of src.matchAll(hostedDynamic)) {
				const idx = match.index ?? 0;
				const lastConst = src.lastIndexOf("\nconst ", idx);
				const start = lastConst >= 0 ? lastConst : 0;
				const snippet = src.slice(start, idx);
				if (!/\bIS_HOSTED\s*\?/.test(snippet)) {
					offenders.push(`${relative(SRC_DIR, file)} — ${match[0].slice(0, 80)}…`);
				}
			}
		}
		if (offenders.length > 0) {
			throw new Error(
				`Ungated dynamic imports of @/hosted/* leak the hosted chunk into OSS bundles:\n  ${offenders.join("\n  ")}\nWrap each in \`const X = IS_HOSTED ? dynamic(…) : null\`.`,
			);
		}
	});
});

describe("posthog-js is hosted-only", () => {
	test("non-hosted source files do not import posthog-js", () => {
		const offenders: string[] = [];
		const posthogImport =
			/(?:^\s*import\s+[^"']+\s+from\s+["']posthog-js["'])|(?:\bimport\s*\(\s*["']posthog-js["']\s*\))/m;

		for (const file of walkSrcExceptHosted(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			if (posthogImport.test(src)) offenders.push(relative(SRC_DIR, file));
		}

		const instrumentationClient = join(SRC_DIR, "..", "instrumentation-client.ts");
		if (existsSync(instrumentationClient)) {
			const src = readFileSync(instrumentationClient, "utf8");
			if (posthogImport.test(src)) {
				offenders.push(relative(SRC_DIR, instrumentationClient));
			}
		}

		if (offenders.length > 0) {
			throw new Error(
				`posthog-js must stay hosted-only. Move imports under src/hosted and reach them via IS_HOSTED-gated dynamic import:\n  ${offenders.join("\n  ")}`,
			);
		}
	});
});

describe("instrumentation-client hosted imports", () => {
	test("hosted dynamic imports are gated by compile-time hosted checks", () => {
		const instrumentationClient = join(SRC_DIR, "..", "instrumentation-client.ts");
		if (!existsSync(instrumentationClient)) return;

		const src = readFileSync(instrumentationClient, "utf8");
		const offenders: string[] = [];
		const hostedDynamic = /import\s*\(\s*["']@\/hosted\/[^"']+["']\s*\)/g;
		const compileTimeHostedGate = /\bprocess\.env\.NEXT_PUBLIC_CLAWDI_HOSTED\s*===\s*["']true["']/;

		for (const match of src.matchAll(hostedDynamic)) {
			const idx = match.index ?? 0;
			const lookbehind = src.slice(Math.max(0, idx - 200), idx);
			if (!/\bIS_HOSTED\b/.test(lookbehind) && !compileTimeHostedGate.test(lookbehind)) {
				offenders.push(`${relative(SRC_DIR, instrumentationClient)} — ${match[0]}`);
			}
		}

		if (offenders.length > 0) {
			throw new Error(
				`instrumentation-client.ts may only reach @/hosted/* behind compile-time hosted gates (IS_HOSTED or process.env.NEXT_PUBLIC_CLAWDI_HOSTED === "true"):\n  ${offenders.join("\n  ")}`,
			);
		}
	});
});

describe("PostHog proxy route boundaries", () => {
	test("next.config.ts gates PostHog rewrites behind hosted builds", () => {
		const nextConfig = join(SRC_DIR, "..", "next.config.ts");
		if (!existsSync(nextConfig)) return;

		const src = readFileSync(nextConfig, "utf8");
		expect(src).toMatch(
			/\bconst\s+isHostedBuild\s*=\s*process\.env\.NEXT_PUBLIC_CLAWDI_HOSTED\s*===\s*["']true["']/,
		);
		expect(src).toMatch(/source:\s*["']\/s\/:id\.md["']\s*,\s*destination:\s*["']\/s\/:id\/md["']/);
		expect(src).toMatch(
			/source:\s*["']\/s\/:id\.json["']\s*,\s*destination:\s*["']\/s\/:id\/json["']/,
		);

		const hostedIfMatch = /\bif\s*\(\s*isHostedBuild\s*\)\s*\{/.exec(src);
		expect(hostedIfMatch).not.toBeNull();
		if (!hostedIfMatch) return;

		const hostedIfOpenBrace = src.indexOf("{", hostedIfMatch.index);
		expect(hostedIfOpenBrace).toBeGreaterThanOrEqual(0);
		if (hostedIfOpenBrace < 0) return;

		const hostedIfCloseBrace = findMatchingBrace(src, hostedIfOpenBrace);
		expect(hostedIfCloseBrace).toBeGreaterThan(hostedIfOpenBrace);
		if (hostedIfCloseBrace <= hostedIfOpenBrace) return;

		const hostedPosthogBlock = src.slice(hostedIfOpenBrace + 1, hostedIfCloseBrace);
		expect(hostedPosthogBlock).toMatch(/rewrites\.push\s*\(/);
		expect(hostedPosthogBlock).toMatch(/source:\s*`\$\{posthogProxyPath\}\/static\/:path\*`/);
		expect(hostedPosthogBlock).toMatch(/source:\s*`\$\{posthogProxyPath\}\/:path\*`/);

		const posthogRewriteSources = [
			...src.matchAll(/source:\s*`\$\{posthogProxyPath\}\/(?:static\/)?:path\*`/g),
		];
		expect(posthogRewriteSources.length).toBe(2);
		for (const sourceMatch of posthogRewriteSources) {
			const sourceIndex = sourceMatch.index ?? -1;
			expect(sourceIndex).toBeGreaterThanOrEqual(hostedIfOpenBrace + 1);
			expect(sourceIndex).toBeLessThan(hostedIfCloseBrace);
		}
	});

	test("proxy.ts only exposes /_cdi/px as public in hosted builds", () => {
		const proxyFile = join(SRC_DIR, "proxy.ts");
		if (!existsSync(proxyFile)) return;

		const src = readFileSync(proxyFile, "utf8");
		expect(src).toMatch(
			/\bconst\s+isHostedBuild\s*=\s*process\.env\.NEXT_PUBLIC_CLAWDI_HOSTED\s*===\s*["']true["']/,
		);
		expect(src).toMatch(
			/if\s*\(\s*isHostedBuild\s*\)\s*\{[\s\S]*publicRoutes\.push\(\s*["']\/_cdi\/px\(\.\*\)["']\s*\)/,
		);
		expect(src).not.toMatch(/createRouteMatcher\s*\(\s*\[[\s\S]*["']\/_cdi\/px\(\.\*\)["']/);
	});
});
