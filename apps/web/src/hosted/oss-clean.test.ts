import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * OSS-clean invariant tests.
 *
 * The hosted/ directory must stay quarantined: hosted components set
 * `data-hosted="true"`, hosted/v2 components also set `data-v2="true"`,
 * and every consumer outside that quarantine is gated by the hosted build
 * flag somewhere in the same file.
 *
 * Static regex / file-walk checks instead of React render tests —
 * apps/web has no jsdom / @testing-library setup and adding it for
 * one invariant would be overkill. The static gates catch the
 * failure modes that matter: forgetting DOM markers, forgetting
 * the hosted build guard when importing gated modules.
 */

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

describe("hosted/ directory invariants", () => {
	test('every .tsx file sets data-hosted="true" on its root', () => {
		const files = listTsx(HOSTED_DIR);
		expect(files.length).toBeGreaterThan(0);
		// Effect-only hosted modules should render no DOM instead of a tagged sentinel.
		const rootlessEffectOnlyFiles = new Set([
			"hosted/access/product-access-sensor.tsx",
			"hosted/analytics-client.tsx",
		]);

		for (const file of files) {
			const rel = relative(SRC_DIR, file);
			const src = stripComments(readFileSync(file, "utf8"));
			if (rootlessEffectOnlyFiles.has(rel) && /\breturn\s+null\b/.test(src)) {
				continue;
			}
			// Tight match: explicit `data-hosted="true"` or `data-hosted={"true"}`.
			// Rejects `data-hosted="false"`, typos, and arbitrary expression forms
			// that would slip past the original looser pattern. Source has had
			// comments stripped so a JSDoc reference to `data-hosted="true"`
			// can no longer satisfy the invariant — a real JSX attribute is
			// required.
			const hasDataHosted = /\bdata-hosted=(?:"true"|\{"true"\})/.test(src);
			if (!hasDataHosted) {
				throw new Error(`${rel}: hosted .tsx must set data-hosted="true" on its rendered root`);
			}
		}
	});
});

describe("hosted/v2 directory invariants", () => {
	test('every .tsx file sets data-v2="true" on its root', () => {
		const files = listTsx(HOSTED_V2_DIR);
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

	test("the unified new-agent entrypoint opens the in-app deploy wizard", () => {
		const src = readFileSync(join(SRC_DIR, "components/dashboard/new-agent-button.tsx"), "utf8");
		expect(src).toContain('router.navigate({ href: "/deploy" })');
		expect(src).not.toContain('from "@/hosted/');
		expect(src).not.toMatch(/href=["']https:\/\/[^"']+\/dashboard["']/);
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

	test("Cloud-agents-off agent index copy stays neutral", () => {
		const agentsIndex = readFileSync(join(SRC_DIR, "pages/dashboard/agents/page.tsx"), "utf8");
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

	test("retired hosted implementation paths stay absent", () => {
		for (const path of [
			"components/hosted-product-gate.tsx",
			"components/header-wallet-balance.tsx",
			"components/providers/analytics-provider.logic.ts",
			"lib/hosted-api.ts",
			"lib/hosted-product-access.ts",
			"lib/hosted-product-access-model.ts",
			"lib/hosted-product-access-request.ts",
			"lib/hosted-url.ts",
			"lib/legacy-hosted-dashboard.ts",
			"lib/wallet-stripe-return.ts",
		]) {
			expect(existsSync(join(SRC_DIR, path))).toBe(false);
		}
	});

	test("shared API errors do not claim hosted or v2 ownership", () => {
		const panel = readFileSync(join(SRC_DIR, "components/api-error-panel.tsx"), "utf8");
		expect(panel).not.toContain("data-hosted");
		expect(panel).not.toContain("data-v2");
	});
});

describe("Mava composition boundary", () => {
	test("the shared Help menu only lazy-composes the hosted Live chat item", () => {
		const sidebar = readFileSync(join(SRC_DIR, "components/app-sidebar.tsx"), "utf8");
		const item = readFileSync(join(HOSTED_DIR, "mava-live-chat-menu-item.tsx"), "utf8");

		expect(sidebar).toContain('import("@/hosted/mava-live-chat-menu-item")');
		expect(sidebar).toMatch(/const MavaLiveChatMenuItem = IS_HOSTED_BUILD\s*\?/);
		expect(sidebar).not.toContain("MavaWebChatToggle");
		expect(sidebar).not.toContain("Live chat");
		expect(item).toContain("requestMavaWebChatToggle");
		expect(item).toContain("<DropdownMenuItem");
		expect(item).toContain("Live chat");
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

describe("Vite hosted flag boundary", () => {
	test("hosted gating uses Vite-native env replacement without custom build plugins", () => {
		const viteConfig = readFileSync(join(SRC_DIR, "..", "vite.config.ts"), "utf8");
		const hostedFlag = readFileSync(join(SRC_DIR, "lib/hosted.ts"), "utf8");

		expect(viteConfig).not.toContain("clawdi-oss-hosted-boundary");
		expect(viteConfig).not.toContain("envPrefix");
		expect(viteConfig).not.toContain("define:");
		expect(hostedFlag).toContain("import.meta.env.VITE_CLAWDI_HOSTED");
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
