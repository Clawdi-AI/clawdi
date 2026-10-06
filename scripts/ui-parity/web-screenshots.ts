#!/usr/bin/env bun
/**
 * Capture phone-viewport screenshots of the web dashboard for UI parity work.
 *
 * Expects a running web dev server started against the fixture API with the
 * dev auth bypass (see README.md). Usage:
 *
 *   bun scripts/ui-parity/web-screenshots.ts [--base-url http://127.0.0.1:3200]
 *     [--out /tmp/clawdi-ui-parity/web] [--theme light|dark]
 *     [--routes name=/path,name2=/path2] [--settle-ms 1500]
 *
 * Route paths may include query strings (`settings=/?settings=general`).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const AGENT_ID = "c1a0de00-0001-4c00-8000-000000000001";
const SESSION_ID = "5e550000-0001-4000-8000-000000000001";
const PROJECT_ID = "a0f1c2d3-0002-4a00-8000-000000000002";

type Shot = { name: string; path: string; fullPage: boolean };

/** Modal routes are captured at viewport size; page routes capture the full scroll height. */
const DEFAULT_ROUTES: readonly Shot[] = [
	{ name: "dashboard", path: "/", fullPage: true },
	{ name: "agents", path: "/agents", fullPage: true },
	{ name: "agent-detail", path: `/agents/${AGENT_ID}`, fullPage: true },
	{ name: "agent-sessions", path: `/agents/${AGENT_ID}/sessions`, fullPage: true },
	{ name: "sessions", path: "/sessions", fullPage: true },
	{ name: "session-detail", path: `/sessions/${SESSION_ID}`, fullPage: true },
	{ name: "projects", path: "/projects", fullPage: true },
	{ name: "project-detail", path: `/projects/${PROJECT_ID}`, fullPage: true },
	{ name: "skills", path: "/skills", fullPage: true },
	{ name: "skill-detail", path: `/skills/design-tokens?project=${PROJECT_ID}`, fullPage: true },
	{ name: "memories", path: "/memories", fullPage: true },
	{ name: "vaults", path: "/vaults", fullPage: true },
	{ name: "vault-detail", path: "/vaults/acme-prod", fullPage: true },
	{ name: "connectors", path: "/connectors", fullPage: true },
	{ name: "settings", path: "/?settings=general", fullPage: false },
];

function readFlag(name: string): string | undefined {
	const args = process.argv.slice(2);
	const index = args.indexOf(`--${name}`);
	if (index >= 0) return args[index + 1];
	return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function parseRoutes(value: string | undefined): readonly Shot[] {
	if (!value) return DEFAULT_ROUTES;
	return value.split(",").map((entry) => {
		const separator = entry.indexOf("=");
		const name = entry.slice(0, separator);
		const path = entry.slice(separator + 1);
		if (separator <= 0 || !path.startsWith("/")) {
			throw new Error(`Invalid --routes entry "${entry}"; expected name=/path`);
		}
		return { name, path, fullPage: !path.includes("settings=") };
	});
}

const baseUrl = readFlag("base-url") ?? "http://127.0.0.1:3200";
const outDir = readFlag("out") ?? "/tmp/clawdi-ui-parity/web";
const settleMs = Number(readFlag("settle-ms") ?? "1500");
const theme = readTheme(readFlag("theme") ?? "light");

function readTheme(value: string): "light" | "dark" {
	if (value === "light" || value === "dark") return value;
	console.error(`Invalid --theme "${value}"; expected light or dark`);
	process.exit(1);
}
const routes = parseRoutes(readFlag("routes"));

async function assertServerReachable() {
	try {
		const response = await fetch(baseUrl, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
	} catch (error) {
		console.error(`Web dev server is not reachable at ${baseUrl}: ${String(error)}`);
		process.exit(1);
	}
}

async function main() {
	await assertServerReachable();
	await mkdir(outDir, { recursive: true });
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			deviceScaleFactor: 3,
			isMobile: true,
			hasTouch: true,
			colorScheme: theme,
			reducedMotion: "reduce",
		});
		// Pin the persisted theme (see apps/web/src/components/theme-provider.tsx)
		// so captures do not depend on the system preference fallback.
		await context.addInitScript((value) => {
			try {
				window.localStorage.setItem("clawdi-theme", value);
			} catch {
				// Storage can be unavailable on opaque origins; colorScheme still applies.
			}
		}, theme);
		const page = await context.newPage();
		const failures: string[] = [];
		page.on("response", (response) => {
			if (response.status() >= 400 && response.url().includes("/v1/")) {
				failures.push(`${response.status()} ${response.url()}`);
			}
		});
		for (const { name, path, fullPage } of routes) {
			failures.length = 0;
			const file = join(outDir, `${name}.png`);
			await page.goto(new URL(path, baseUrl).toString(), { waitUntil: "networkidle" });
			await page.waitForTimeout(settleMs);
			await page.screenshot({ path: file, fullPage, animations: "disabled" });
			const suffix = failures.length ? `  (API errors: ${failures.join("; ")})` : "";
			console.log(`${name.padEnd(16)} ${path} -> ${file}${suffix}`);
		}
	} finally {
		await browser.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
