import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/**
 * OSS-clean invariant tests.
 *
 * The hosted/ and v2/ directories must stay quarantined: hosted components set
 * `data-hosted="true"`, v2 components set `data-v2="true"`, and every
 * consumer outside those quarantines is gated by `IS_HOSTED` somewhere in the
 * same file.
 *
 * Static regex / file-walk checks instead of React render tests —
 * apps/web has no jsdom / @testing-library setup and adding it for
 * one invariant would be overkill. The static gates catch the
 * failure modes that matter: forgetting DOM markers, forgetting
 * the IS_HOSTED guard when importing gated modules.
 */

const HOSTED_DIR = join(import.meta.dir);
const SRC_DIR = join(import.meta.dir, "..");
const V2_DIR = join(SRC_DIR, "v2");
const APP_DIR = join(SRC_DIR, "app");
const V2_ONLY_ROUTE_IMPORT =
	/\bimport\s*\(\s*["']@\/(?:v2\/|hosted\/billing\/(?:deploy|subscription|usage|wallet)\/)[^"']+["']\s*\)/;

function listTsx(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current)) {
			const full = join(current, entry);
			const st = statSync(full);
			if (st.isDirectory()) walk(full);
			else if (entry.endsWith(".tsx")) out.push(full);
		}
	};
	walk(dir);
	return out;
}

function walkSrcExceptQuarantined(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (full === HOSTED_DIR || full === V2_DIR) continue;
			walkSrcExceptQuarantined(full, out);
		} else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
			out.push(full);
		}
	}
	return out;
}

function hasV2Gate(file: string): boolean {
	const src = readFileSync(file, "utf8");
	return src.includes('from "@/components/v2-gate"') && /<V2Gate(?:\s|>)/.test(src);
}

function nearestV2GateFile(routeFile: string): string | null {
	if (hasV2Gate(routeFile)) return routeFile;

	let dir = dirname(routeFile);
	while (dir.startsWith(APP_DIR)) {
		const layoutFile = join(dir, "layout.tsx");
		if (layoutFile !== routeFile && existsSync(layoutFile) && hasV2Gate(layoutFile)) {
			return layoutFile;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return null;
}

function discoverV2OnlyRouteFiles(): string[] {
	const gateFiles = new Set<string>();
	const ungatedRouteFiles: string[] = [];

	for (const file of listTsx(APP_DIR)) {
		if (!/(?:^|\/)(?:page|layout)\.tsx$/.test(file)) continue;
		const src = readFileSync(file, "utf8");
		if (!V2_ONLY_ROUTE_IMPORT.test(src)) continue;

		const gateFile = nearestV2GateFile(file);
		if (gateFile) {
			gateFiles.add(relative(SRC_DIR, gateFile));
		} else {
			ungatedRouteFiles.push(relative(SRC_DIR, file));
		}
	}

	if (ungatedRouteFiles.length > 0) {
		throw new Error(
			`V2-only route entrypoints must render inside <V2Gate> directly or through a parent layout:\n  ${ungatedRouteFiles.join("\n  ")}`,
		);
	}

	expect(gateFiles.size).toBeGreaterThan(0);
	return [...gateFiles].sort();
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
		const files = listTsx(HOSTED_DIR);
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

describe("v2/ directory invariants", () => {
	test('every .tsx file sets data-v2="true" on its root', () => {
		const files = listTsx(V2_DIR);
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const src = stripComments(readFileSync(file, "utf8"));
			const hasDataV2 = /\bdata-v2=(?:"true"|\{"true"\})/.test(src);
			if (!hasDataV2) {
				throw new Error(
					`${relative(SRC_DIR, file)}: v2 .tsx must set data-v2="true" on its rendered root`,
				);
			}
		}
	});

	test("v2 product modules do not depend on hosted agent infrastructure", () => {
		const offenders: string[] = [];
		for (const file of [...listTsx(V2_DIR), ...listTs(V2_DIR)]) {
			const src = readFileSync(file, "utf8");
			if (/@\/hosted\//.test(src)) offenders.push(relative(SRC_DIR, file));
		}
		if (offenders.length > 0) {
			throw new Error(
				`v2 product modules must not import hosted agent infrastructure:\n  ${offenders.join("\n  ")}`,
			);
		}
	});
});

function listTs(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current)) {
			const full = join(current, entry);
			const st = statSync(full);
			if (st.isDirectory()) walk(full);
			else if (entry.endsWith(".ts")) out.push(full);
		}
	};
	walk(dir);
	return out;
}

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
		for (const file of walkSrcExceptQuarantined(SRC_DIR)) {
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

describe("no static @/v2/* imports outside v2/ or hosted/", () => {
	test("OSS-reachable files only reach v2/ via dynamic imports", () => {
		const offenders: string[] = [];
		for (const file of walkSrcExceptQuarantined(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			if (/^\s*import\s+[^"']+from\s+["']@\/v2\//m.test(src)) {
				offenders.push(relative(SRC_DIR, file));
			}
		}
		if (offenders.length > 0) {
			throw new Error(
				`Static @/v2/* imports leak the v2 chunk into OSS bundles:\n  ${offenders.join("\n  ")}\nUse dynamic imports gated on IS_HOSTED instead.`,
			);
		}
	});
});

describe("dynamic gated-module imports are gated by IS_HOSTED", () => {
	test('every `dynamic(import("@/hosted/…"))` or `dynamic(import("@/v2/…"))` is constructed inside `IS_HOSTED ? … : null`', () => {
		// Why this matters: a bare `dynamic(() => import("@/hosted/x"))`
		// or `dynamic(() => import("@/v2/x"))` at module top level would
		// register the gated chunk in the OSS
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
		const gatedDynamic =
			/dynamic\s*\(\s*\(\s*\)\s*=>\s*import\s*\(\s*["']@\/(?:hosted|v2)\/[^"']+["']/g;
		for (const file of walkSrcExceptQuarantined(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			for (const match of src.matchAll(gatedDynamic)) {
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
				`Ungated dynamic imports of @/hosted/* or @/v2/* leak gated chunks into OSS bundles:\n  ${offenders.join("\n  ")}\nWrap each in \`const X = IS_HOSTED ? dynamic(…) : null\`.`,
			);
		}
	});
});

describe("v2 route exposure", () => {
	test("v2-only routes are behind the per-user V2 gate, not only the build flag", () => {
		const routeFiles = discoverV2OnlyRouteFiles();

		const offenders: string[] = [];
		for (const routeFile of routeFiles) {
			const full = join(SRC_DIR, routeFile);
			const src = readFileSync(full, "utf8");
			if (!src.includes('from "@/components/v2-gate"') || !/<V2Gate(?:\s|>)/.test(src)) {
				offenders.push(routeFile);
			}
			if (/return\s+[A-Z][A-Za-z0-9]*\s*\?\s*\(\s*<V2Gate/.test(src)) {
				offenders.push(`${routeFile} (short-circuits before V2Gate)`);
			}
		}

		if (offenders.length > 0) {
			throw new Error(
				`V2-only routes must render through <V2Gate>, not just IS_HOSTED:\n  ${offenders.join("\n  ")}`,
			);
		}
	});

	test("the unified new-agent entrypoint opens the in-app v2 wizard", () => {
		const src = readFileSync(join(SRC_DIR, "components/dashboard/new-agent-button.tsx"), "utf8");
		expect(src).toContain('router.push("/deploy")');
		expect(src).not.toContain('from "@/hosted/');
		expect(src).not.toMatch(/href=["']https:\/\/[^"']+\/dashboard["']/);
	});

	test("v2-off agent index copy stays neutral", () => {
		const agentsIndex = readFileSync(join(SRC_DIR, "app/(dashboard)/agents/page.tsx"), "utf8");
		const agentsCard = readFileSync(join(SRC_DIR, "components/dashboard/agents-card.tsx"), "utf8");
		expect(agentsIndex).not.toContain("hosted on your account");
		expect(agentsCard).not.toContain("deploy a hosted one");
	});
});

describe("posthog-js is hosted-only", () => {
	test("non-hosted source files do not import posthog-js", () => {
		const offenders: string[] = [];
		const posthogImport =
			/(?:^\s*import\s+[^"']+\s+from\s+["']posthog-js["'])|(?:\bimport\s*\(\s*["']posthog-js["']\s*\))/m;

		for (const file of walkSrcExceptQuarantined(SRC_DIR)) {
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
