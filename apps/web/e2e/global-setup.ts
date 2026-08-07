import type { FullConfig } from "@playwright/test";

/**
 * The dev server compiles route chunks on first hit; cold transforms race
 * per-assertion timeouts and flake nondeterministically under load. Warm the
 * main route graph once up front (status codes irrelevant — SSR API calls
 * fail by design without a backend) so every test sees a hot server.
 */
const ROUTES = [
	"/",
	"/agents/agent-smoke-1",
	"/agents/agent-smoke-1/sessions",
	"/agents/agent-smoke-1/memories",
	"/agents/agent-smoke-1/connectors",
	"/agents/agent-smoke-1/settings",
	"/agents/agent-smoke-1/project-access/project-smoke/skills",
	"/projects",
	"/projects/project-smoke",
	"/sessions",
	"/skills",
	"/vaults",
	"/connectors",
	"/settings?settings=general",
];

export default async function globalSetup(config: FullConfig) {
	const baseURL = config.projects[0]?.use.baseURL ?? "http://127.0.0.1:3200";
	for (const route of ROUTES) {
		try {
			await fetch(`${baseURL}${route}`, { redirect: "follow" });
		} catch {
			// Warm-up is best-effort; a cold route only costs the old flake risk.
		}
	}
}
