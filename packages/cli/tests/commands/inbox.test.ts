import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inboxAcceptCommand } from "../../src/commands/inbox";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origApiUrl: string | undefined;

const rawToken = "a".repeat(43);

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	tmpHome = join(tmpdir(), `clawdi-inbox-${Date.now()}-${Math.random().toString(36)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(join(tmpHome, ".clawdi", "auth.json"), JSON.stringify({ apiKey: "test-key" }));
	process.env.HOME = tmpHome;
	process.env.CLAWDI_API_URL = "http://api.test";
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpHome, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe("inboxAcceptCommand", () => {
	it("prints exact use-with-agent command when accepting project access", async () => {
		const { restore } = mockFetch([
			{
				method: "POST",
				path: `/api/share/${rawToken}/upgrade`,
				response: () =>
					jsonResponse({
						membership_id: "membership-1",
						project_id: "uuid-project-shared",
						role: "viewer",
						joined_via: "link",
						joined_at: "2026-05-14T00:00:00Z",
						resolved_owner_handle: "alice-a3b4",
					}),
			},
			{
				method: "GET",
				path: "/api/skills",
				response: () => jsonResponse({ items: [] }),
			},
			{
				method: "GET",
				path: "/api/projects",
				response: () =>
					jsonResponse([
						{
							id: "uuid-project-shared",
							slug: "shared-toolkit",
							name: "Shared Toolkit",
							kind: "workspace",
							is_owner: false,
							owner_handle: "alice-a3b4",
						},
					]),
			},
		]);
		const orig = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			await inboxAcceptCommand(`https://clawdi.ai/share/${rawToken}`, {});
		} finally {
			console.log = orig;
			restore();
		}

		const out = lines.join("\n");
		expect(out).toContain("Accepted project access for @alice-a3b4/shared-toolkit.");
		expect(out).toContain("Role: viewer (read-only).");
		expect(out).toContain(
			"Use with agent: clawdi agent projects add-context <agent-id> --project @alice-a3b4/shared-toolkit",
		);
		expect(out).not.toMatch(/\bbind(ing|s)?\b/i);
	});
});
