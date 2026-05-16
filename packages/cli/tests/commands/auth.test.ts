import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { authLogin } from "../../src/commands/auth";
import { addToken, listTokens } from "../../src/share/tokens";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origApiUrl: string | undefined;
let origAuthToken: string | undefined;
let origExitCode: typeof process.exitCode;

const rawToken = "a".repeat(43);

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	origAuthToken = process.env.CLAWDI_AUTH_TOKEN;
	origExitCode = process.exitCode;

	tmpHome = join(tmpdir(), `clawdi-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	writeFileSync(
		join(tmpHome, ".clawdi", "auth.json"),
		JSON.stringify({ apiKey: "bob-key", userId: "bob", email: "bob@example.test" }),
	);

	process.env.HOME = tmpHome;
	delete process.env.CLAWDI_HOME;
	process.env.CLAWDI_API_URL = "http://api.test";
	delete process.env.CLAWDI_AUTH_TOKEN;
	process.exitCode = undefined;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origClawdiHome) process.env.CLAWDI_HOME = origClawdiHome;
	else delete process.env.CLAWDI_HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	if (origAuthToken) process.env.CLAWDI_AUTH_TOKEN = origAuthToken;
	else delete process.env.CLAWDI_AUTH_TOKEN;
	process.exitCode = origExitCode;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("authLogin pending share upgrade", () => {
	it("upgrades anonymous share tokens and eager-pulls shared skills", async () => {
		addToken({
			project_id: "project-shared",
			project_name: "Team Toolkit",
			owner_display: "Alice",
			owner_handle: "alice-example",
			token: rawToken,
			redeemed_at: "2026-05-12T10:00:00Z",
		});

		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: `/api/share/${rawToken}/upgrade`,
				response: () =>
					jsonResponse({
						project_id: "project-shared",
						resolved_owner_handle: "alice-example",
						membership_id: "membership-1",
					}),
			},
			{
				method: "GET",
				path: "/api/skills",
				response: () =>
					jsonResponse({
						items: [{ project_id: "project-shared", skill_key: "deploy-helper", is_active: true }],
					}),
			},
			{
				method: "GET",
				path: "/api/projects/project-shared/skills/deploy-helper/download",
				response: () => new Response(new Uint8Array([1, 2, 3])),
			},
		]);

		try {
			await authLogin();
		} finally {
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			`POST /api/share/${rawToken}/upgrade`,
			"GET /api/skills?project_id=project-shared&page=1&page_size=200",
			"GET /api/projects/project-shared/skills/deploy-helper/download",
		]);

		const [token] = listTokens();
		expect(token.upgraded_at).toBeString();
		expect(token.last_seen_skill_keys).toEqual(["deploy-helper"]);
	});

	it("skips invalid server skill keys during eager pull", async () => {
		addToken({
			project_id: "project-shared",
			project_name: "Team Toolkit",
			owner_display: "Alice",
			owner_handle: "alice-example",
			token: rawToken,
			redeemed_at: "2026-05-12T10:00:00Z",
		});

		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: `/api/share/${rawToken}/upgrade`,
				response: () =>
					jsonResponse({
						project_id: "project-shared",
						resolved_owner_handle: "alice-example",
						membership_id: "membership-1",
					}),
			},
			{
				method: "GET",
				path: "/api/skills",
				response: () =>
					jsonResponse({
						items: [
							{ project_id: "project-shared", skill_key: "deploy-helper", is_active: true },
							{ project_id: "project-shared", skill_key: "../escape", is_active: true },
						],
					}),
			},
			{
				method: "GET",
				path: "/api/projects/project-shared/skills/deploy-helper/download",
				response: () => new Response(new Uint8Array([1, 2, 3])),
			},
		]);

		try {
			await authLogin();
		} finally {
			restore();
		}

		expect(captured.map((r) => `${r.method} ${r.path}`)).toEqual([
			`POST /api/share/${rawToken}/upgrade`,
			"GET /api/skills?project_id=project-shared&page=1&page_size=200",
			"GET /api/projects/project-shared/skills/deploy-helper/download",
		]);
		const [token] = listTokens();
		expect(token.last_seen_skill_keys).toEqual(["deploy-helper"]);
	});
});
