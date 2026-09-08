import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Hosted modules must remain outside the OSS client graph. */

const HOSTED_DIR = join(import.meta.dir);
const SRC_DIR = join(import.meta.dir, "..");
const HOSTED_V2_DIR = join(HOSTED_DIR, "v2");
const PAGES_DIR = join(SRC_DIR, "pages");
const CAPABILITY_INDEPENDENT_HOSTED_ROUTES = new Set(["oauth/codex/callback/page.tsx"]);
const GATED_ROUTE_DYNAMIC_IMPORT =
	/\bimport\s*\(\s*["'](@\/hosted\/(?:v2\/|billing\/)[^"']+)["']\s*\)/g;

function listTsx(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current)) {
			const full = join(current, entry);
			const st = statSync(full);
			if (st.isDirectory()) walk(full);
			// Structural invariants apply to production UI components; test files
			// (.test.tsx) render assertion fragments, not a hosted UI root.
			else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) out.push(full);
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
			if (full === HOSTED_DIR) continue;
			walkSrcExceptQuarantined(full, out);
		} else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
			out.push(full);
		}
	}
	return out;
}

function routeUsesHostedProductOnlyModule(src: string): boolean {
	for (const match of src.matchAll(GATED_ROUTE_DYNAMIC_IMPORT)) {
		const target = match[1];
		if (target.startsWith("@/hosted/v2/")) return true;
		// Hosted billing routes are per-user hosted product surfaces, except
		// the agents dashboard control strip. That strip is an IS_HOSTED-only
		// dashboard adornment and not a standalone hosted product route.
		if (target.startsWith("@/hosted/billing/") && !target.startsWith("@/hosted/billing/agents/")) {
			return true;
		}
	}
	return false;
}

function discoverHostedProductOnlyRouteFiles(): string[] {
	const routeFiles: string[] = [];

	for (const file of listTsx(PAGES_DIR)) {
		if (!/(?:^|\/)(?:page|layout)\.tsx$/.test(file)) continue;
		const src = readFileSync(file, "utf8");
		if (!routeUsesHostedProductOnlyModule(src)) continue;
		// OAuth protocol callbacks must hand the authorization response back to
		// their opener even while the per-user capability check is unavailable.
		if (CAPABILITY_INDEPENDENT_HOSTED_ROUTES.has(relative(PAGES_DIR, file))) continue;
		routeFiles.push(relative(SRC_DIR, file));
	}

	expect(routeFiles.length).toBeGreaterThan(0);
	return routeFiles.sort();
}

describe("IS_HOSTED flag", () => {
	test("defaults to false when env var is unset", () => {
		const env = { ...process.env };
		delete env.VITE_CLAWDI_HOSTED;
		env.VITE_CLERK_PUBLISHABLE_KEY ??= "pk_test_dummy_for_unit_tests";

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

describe("no static @/hosted/* imports outside hosted/", () => {
	test("non-hosted files only reach hosted/ via dynamic imports", () => {
		// Static imports of `@/hosted/*` from any OSS-reachable file
		// would pull the hosted chunk into the OSS main bundle even
		// when the runtime usage is gated by `IS_HOSTED`. The fix is
		// always `lazy(() => import("@/hosted/…"))` constructed
		// inside an `IS_HOSTED_BUILD ? … : null` ternary so the OSS bundler
		// statically eliminates the import() site. This test fails if
		// anyone re-introduces a static `from "@/hosted/…"` import.
		const offenders: string[] = [];
		for (const file of walkSrcExceptQuarantined(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			// Match top-of-file `import … from "@/hosted/…"` — lazy arrow-callbacks
			// use `import("…")` (no `from` keyword).
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

describe("no static @/hosted/v2/* imports outside hosted/", () => {
	test("OSS-reachable files only reach hosted/v2 via dynamic imports", () => {
		const offenders: string[] = [];
		for (const file of walkSrcExceptQuarantined(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			if (/^\s*import\s+[^"']+from\s+["']@\/hosted\/v2\//m.test(src)) {
				offenders.push(relative(SRC_DIR, file));
			}
		}
		if (offenders.length > 0) {
			throw new Error(
				`Static @/hosted/v2/* imports leak hosted-only chunks into OSS bundles:\n  ${offenders.join("\n  ")}\nUse dynamic imports gated on IS_HOSTED instead.`,
			);
		}
	});
});

describe("gated-module imports use the Vite hosted flag", () => {
	test("every hosted dynamic import outside hosted/ is constructed behind a compile-time ternary", () => {
		// Why this matters: a bare `lazy(() => import("@/hosted/x"))`
		// or `lazy(() => import("@/hosted/v2/x"))` at module top level would
		// register the gated chunk in the OSS
		// client build graph even though `IS_HOSTED_BUILD &&
		// <Component />` keeps it from rendering. The runtime bundler
		// only eliminates the import() call when the surrounding
		// expression is provably unreachable — `IS_HOSTED_BUILD ? lazy(…)
		// : null` collapses to `null` at build time once
		// `VITE_CLAWDI_HOSTED` is folded in, taking the entire
		// import() with it.
		const offenders: string[] = [];
		// Anchor on each `lazy(() => import("@/hosted/…"))` call,
		// then walk backwards to the most recent `const ` keyword. The
		// snippet between the two must contain `IS_HOSTED_BUILD ?` — that's
		// the gate the bundler folds at build time.
		const hostedDynamic = /import\s*\(\s*["']@\/hosted\/[^"']+["']\s*\)/g;
		for (const file of walkSrcExceptQuarantined(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			for (const match of src.matchAll(hostedDynamic)) {
				const idx = match.index ?? 0;
				const lastConst = src.lastIndexOf("\nconst ", idx);
				const start = lastConst >= 0 ? lastConst : 0;
				const snippet = src.slice(start, idx);
				if (!/\bIS_HOSTED(?:_BUILD)?\s*\?/.test(snippet)) {
					offenders.push(`${relative(SRC_DIR, file)} — ${match[0].slice(0, 80)}…`);
				}
			}
		}
		if (offenders.length > 0) {
			throw new Error(
				`Ungated dynamic imports of @/hosted/* leak hosted chunks into OSS bundles:\n  ${offenders.join("\n  ")}\nConstruct each importer in an IS_HOSTED_BUILD ternary.`,
			);
		}
	});
});

describe("hosted product route exposure", () => {
	test("hosted product routes load their product chunk only through the shared access shell", () => {
		const routeFiles = discoverHostedProductOnlyRouteFiles();
		const offenders: string[] = [];
		for (const routeFile of routeFiles) {
			const full = join(SRC_DIR, routeFile);
			const src = readFileSync(full, "utf8");
			if (
				!src.includes('from "@/components/hosted-product-route"') ||
				!/<HostedProductRoute(?:\s|>)/.test(src) ||
				!/\bIS_HOSTED_BUILD\s*\?\s*lazy\s*\(/.test(src)
			) {
				offenders.push(routeFile);
			}
			if (src.includes("hosted-product-gate") || /<HostedProductGate(?:\s|>)/.test(src)) {
				offenders.push(`${routeFile} (reaches the hosted gate directly)`);
			}
		}

		if (offenders.length > 0) {
			throw new Error(
				`Hosted product routes must lazy-load their page through <HostedProductRoute>:\n  ${offenders.join("\n  ")}`,
			);
		}

		const shellPath = join(SRC_DIR, "components/hosted-product-route.tsx");
		const shell = readFileSync(shellPath, "utf8");
		expect(shell).toContain('import("@/hosted/access/hosted-product-gate")');
		expect(shell).toMatch(/const HostedProductGate = IS_HOSTED_BUILD\s*\?\s*lazy\s*\(/);
		expect(shell).toMatch(/<Suspense[^>]*>[\s\S]*<HostedProductGate(?:\s|>)/);

		const directGateConsumers = walkSrcExceptQuarantined(SRC_DIR)
			.filter((file) =>
				/import\s*\(\s*["']@\/hosted\/access\/hosted-product-gate["']\s*\)/.test(
					readFileSync(file, "utf8"),
				),
			)
			.map((file) => relative(SRC_DIR, file));
		expect(directGateConsumers).toEqual(["components/hosted-product-route.tsx"]);
	});

	test("the Codex OAuth callback relays independently of the capability gate", () => {
		const route = readFileSync(join(PAGES_DIR, "oauth/codex/callback/page.tsx"), "utf8");
		const callback = readFileSync(
			join(HOSTED_V2_DIR, "ai-providers/codex-oauth-callback.tsx"),
			"utf8",
		);
		expect(route).not.toContain("HostedProductGate");
		expect(callback).toContain("channel.postMessage(result)");
		expect(callback).toContain("window.opener?.postMessage(");
		expect(callback).toContain("window.history.replaceState(");
		expect(callback).not.toContain("localStorage");
		expect(callback).not.toContain("sessionStorage");
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

describe("@xterm packages are hosted-only", () => {
	test("non-hosted source files do not import terminal runtime packages", () => {
		const offenders: string[] = [];
		const xtermImport =
			/(?:^\s*import\s+[^"']+\s+from\s+["']@xterm\/[^"']+["'])|(?:\bimport\s*\(\s*["']@xterm\/[^"']+["']\s*\))/m;

		for (const file of walkSrcExceptQuarantined(SRC_DIR)) {
			const src = readFileSync(file, "utf8");
			if (xtermImport.test(src)) offenders.push(relative(SRC_DIR, file));
		}

		if (offenders.length > 0) {
			throw new Error(
				`@xterm packages must stay hosted-only. Keep terminal runtime imports under src/hosted and reach them via IS_HOSTED-gated lazy import:\n  ${offenders.join("\n  ")}`,
			);
		}
	});

	test("global CSS does not import or style the hosted terminal", () => {
		const globalCss = readFileSync(join(SRC_DIR, "styles/globals.css"), "utf8");
		const hostedCss = readFileSync(join(HOSTED_DIR, "agents/hosted-terminal.css"), "utf8");

		expect(globalCss).not.toContain("@xterm/");
		expect(globalCss).not.toContain(".hosted-terminal");
		expect(hostedCss).toContain('@import "@xterm/xterm/css/xterm.css"');
		expect(hostedCss).toContain(".hosted-terminal");
	});
});

describe("hosted implementation ownership", () => {
	test("hosted-only implementation signatures do not occur in shared production modules", () => {
		const signatures = [
			["Deploy API schema client", /\bDeployPaths\b/],
			["hosted capability wire fields", /\bcan_use_v[12]\b/],
			[
				"hosted analytics identity",
				/\b(?:resolveHostedAuthIdentityAction|buildHostedPersonProperties)\b/,
			],
			["Mava SDK globals", /\b(?:MavaWebChatToggle|loadMavaWebchat)\b|window\.Mava\b/],
			[
				"Wallet return lifecycle",
				/\b(?:WalletStripeReturnState|coordinateWallet(?:Payment|Setup)Return|walletSetupIdentityIsCanonical)\b/,
			],
			["Stripe SDK", /(?:from\s+|import\s*\()["']@stripe\//],
		] as const;
		const offenders: string[] = [];

		for (const file of walkSrcExceptQuarantined(SRC_DIR)) {
			if (/\.test\.tsx?$/.test(file)) continue;
			const src = readFileSync(file, "utf8");
			for (const [label, pattern] of signatures) {
				if (pattern.test(src)) offenders.push(`${relative(SRC_DIR, file)} (${label})`);
			}
		}

		expect(offenders).toEqual([]);
	});
});

describe("Wallet return security boundary", () => {
	test("client scrubs or captures return secrets before telemetry evaluates", () => {
		const client = readFileSync(join(SRC_DIR, "client.tsx"), "utf8");
		const bootstrap = readFileSync(join(SRC_DIR, "wallet-stripe-return.bootstrap.ts"), "utf8");

		expect(client.indexOf("await bootstrapWalletStripeReturnBeforeTelemetry()")).toBeLessThan(
			client.indexOf('import("./instrument.client")'),
		);
		expect(bootstrap).toMatch(/const loadHostedWalletStripeReturn = IS_HOSTED_BUILD\s*\?/);
		expect(bootstrap).toContain('import("@/hosted/billing/wallet/stripe-return")');
		expect(bootstrap).toContain("if (!hasWalletStripeReturnUrl(currentHref)) return");
		expect(bootstrap.indexOf("scrubWalletStripeReturnLocation(")).toBeLessThan(
			bootstrap.indexOf("await loadHostedWalletStripeReturn()"),
		);
	});
});

describe("instrumentation-client hosted imports", () => {
	test("server instrumentation is the first static import", () => {
		const serverEntry = readFileSync(join(SRC_DIR, "server.ts"), "utf8");
		expect(serverEntry.trimStart().startsWith('import "../instrument.server.mjs";')).toBe(true);
		expect(serverEntry).not.toContain('await import("../instrument.server.mjs")');
	});

	test("hosted dynamic imports are gated by compile-time hosted checks", () => {
		const instrumentationClient = join(SRC_DIR, "..", "instrumentation-client.ts");
		if (!existsSync(instrumentationClient)) return;

		const src = readFileSync(instrumentationClient, "utf8");
		const offenders: string[] = [];
		const hostedDynamic = /import\s*\(\s*["']@\/hosted\/[^"']+["']\s*\)/g;
		const compileTimeHostedGate = /\bimport\.meta\.env\.VITE_CLAWDI_HOSTED\s*===\s*["']true["']/;

		for (const match of src.matchAll(hostedDynamic)) {
			const idx = match.index ?? 0;
			const lookbehind = src.slice(Math.max(0, idx - 200), idx);
			if (!/\bIS_HOSTED\b/.test(lookbehind) && !compileTimeHostedGate.test(lookbehind)) {
				offenders.push(`${relative(SRC_DIR, instrumentationClient)} — ${match[0]}`);
			}
		}

		if (offenders.length > 0) {
			throw new Error(
				`instrumentation-client.ts may only reach @/hosted/* behind compile-time hosted gates (IS_HOSTED or import.meta.env.VITE_CLAWDI_HOSTED === "true"):\n  ${offenders.join("\n  ")}`,
			);
		}
	});
});

describe("Vercel route boundaries", () => {
	test("keeps public redirects and PostHog proxy rewrites explicit", () => {
		const vercelConfig = join(SRC_DIR, "..", "vercel.json");
		expect(existsSync(vercelConfig)).toBe(true);

		const config = JSON.parse(readFileSync(vercelConfig, "utf8")) as {
			rewrites?: Array<{ source: string; destination: string }>;
			redirects?: Array<{ source: string; destination: string; permanent: boolean }>;
		};
		expect(config.redirects).toContainEqual({
			source: "/install.sh",
			destination: "https://raw.githubusercontent.com/Clawdi-AI/clawdi/main/install.sh",
			permanent: false,
		});
		expect(config.rewrites).toContainEqual({
			source: "/_cdi/px/static/:path*",
			destination: "https://us-assets.i.posthog.com/static/:path*",
		});
		expect(config.rewrites).toContainEqual({
			source: "/_cdi/px/:path*",
			destination: "https://us.i.posthog.com/:path*",
		});
	});
});
