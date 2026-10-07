import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vaultRequest } from "../../src/commands/vault";
import { jsonResponse, mockFetch } from "./helpers";

const projectId = "00000000-0000-0000-0000-000000000001";
const vaultId = "00000000-0000-0000-0000-000000000002";
const requestId = "00000000-0000-0000-0000-000000000003";
const channelId = "00000000-0000-0000-0000-000000000004";
const childId = "00000000-0000-0000-0000-000000000005";
const entry = resolve(import.meta.dir, "../../src/index.ts");
const provider = {
	id: childId,
	provider_id: "openai-main",
	type: "openai",
	label: "Cloud provider",
	base_url: "https://api.openai.com/v1",
	api_mode: "openai_responses",
	managed_by: "user",
	auth: { type: "secret_ref", ref: "env:OPENAI_API_KEY" },
	models: [{ id: "gpt-test" }],
};
const vaultPage = { items: [{ id: vaultId, slug: "default", project_ids: [projectId] }], total: 1 };
const created = {
	id: requestId,
	url: "https://cloud.example.test/vault-request#capability",
	status: "pending",
	expires_at: "2027-01-01T00:00:00Z",
	secret_value: "NEVER_PRINT_SECRET",
};
const impact = {
	provider_id: provider.provider_id,
	impact_revision: "a".repeat(64),
	provider_incarnation_token: "b".repeat(64),
	agents: [{ deployment_id: "hdep_test", name: "Test Cloud Agent" }],
};
type Call = { method: string; path: string; query: string; body: unknown; headers: Headers };
let taskHome: string;
let server: ReturnType<typeof Bun.serve>;
let calls: Call[];
let handler: (call: Call) => Response;

beforeEach(() => {
	taskHome = mkdtempSync(join(tmpdir(), "clawdi-batch-d-"));
	mkdirSync(join(taskHome, ".clawdi"));
	calls = [];
	handler = () => jsonResponse({ detail: "Unexpected mock route" }, 404);
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const call = {
				method: req.method,
				path: url.pathname,
				query: url.search,
				body: req.method === "GET" ? undefined : await req.json().catch(() => undefined),
				headers: req.headers,
			};
			calls.push(call);
			return handler(call);
		},
	});
	signIn();
});

afterEach(() => {
	server.stop(true);
	rmSync(taskHome, { recursive: true, force: true });
});

function signIn(oauth = false) {
	const token = `${Buffer.from(JSON.stringify({ typ: "at+jwt", alg: "RS256" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "test-user", exp: 2000000000 })).toString("base64url")}.signature`;
	writeFileSync(
		join(taskHome, ".clawdi/auth.json"),
		JSON.stringify({
			apiKey: oauth ? token : "test-key",
			endpointBinding: {
				version: 1,
				cloudApiOrigin: server.url.origin,
				hostedApiOrigin: server.url.origin,
			},
			...(oauth
				? {
						authType: "clerk_oauth",
						refreshToken: "test-refresh",
						accessTokenExpiresAt: "2030-01-01T00:00:00Z",
						issuer: "https://clerk.example.test",
						clientId: "test-client",
						audience: "test-audience",
						tokenEndpoint: "https://clerk.example.test/token",
						scopes: [],
						subject: "test-user",
						userId: "user-1",
					}
				: {}),
		}),
	);
}

function seedCatalog(ids = ["openai-main", "local-only"]) {
	mkdirSync(join(taskHome, ".clawdi/ai-providers"), { recursive: true });
	writeFileSync(
		join(taskHome, ".clawdi/ai-providers/catalog.json"),
		JSON.stringify({
			schema_version: 1,
			providers: ids.map((id) => ({
				id,
				type: "openai",
				base_url: "https://api.openai.com/v1",
				auth: { type: "secret_ref", ref: `env:${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY` },
				models: [{ id: "local-model" }],
			})),
		}),
	);
}

async function cli(args: string[]) {
	const child = Bun.spawn(["bun", entry, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: taskHome,
			CLAWDI_HOME: join(taskHome, ".clawdi"),
			CLAWDI_AUTH_TOKEN: "",
			CLAWDI_API_URL: server.url.origin,
			CLAWDI_DEPLOY_API_URL: server.url.origin,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
			NO_COLOR: "1",
		},
	});
	const timeout = setTimeout(() => child.kill(), 15000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	} finally {
		clearTimeout(timeout);
	}
}

describe("AI provider Cloud parity", () => {
	test("local-only edit and removal keep using the import/export catalog", async () => {
		seedCatalog(["local-only"]);
		handler = () => jsonResponse({ providers: [] });
		const edited = await cli(["ai-provider", "edit", "local-only", "--label", "Local", "--json"]);
		expect({ code: edited.code, stderr: edited.stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(edited.stdout)).toMatchObject({
			schemaVersion: "clawdi.aiProviderEdit.v1",
			updated: "local-only",
			provider: { source: "local", label: "Local" },
		});
		const removed = await cli(["ai-provider", "remove", "local-only", "--yes", "--json"]);
		expect({ code: removed.code, stderr: removed.stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(removed.stdout)).toMatchObject({
			schemaVersion: "clawdi.aiProviderRemove.v1",
			removed: "local-only",
			source: "local",
		});
		expect(calls.every((call) => call.method === "GET")).toBe(true);
	});

	test("Hosted authorization failure cannot fall back to a Cloud deletion", async () => {
		signIn(true);
		handler = (call) =>
			call.path.endsWith("removal-impact")
				? jsonResponse({ detail: "Forbidden" }, 403)
				: jsonResponse({ providers: [provider] });
		const result = await cli(["ai-provider", "remove", "openai-main", "--yes", "--json"]);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(calls.every((call) => call.method === "GET")).toBe(true);
	});
	test("merges Cloud and local-only entries while preserving the legacy envelope", async () => {
		seedCatalog();
		handler = () => jsonResponse({ providers: [provider] });
		const result = await cli(["ai-provider", "list", "--json"]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			schema_version: 1,
			providers: [
				{ id: "openai-main", source: "cloud", label: "Cloud provider" },
				{ id: "local-only", source: "local" },
			],
		});
		expect(calls.map((call) => call.path)).toEqual(["/v1/ai-providers"]);
	});

	test("signed-out listing explains local-only results on stderr", async () => {
		seedCatalog(["local-only"]);
		rmSync(join(taskHome, ".clawdi/auth.json"));
		const result = await cli(["ai-provider", "list", "--json"]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(result.stderr).toContain("Not signed in");
		expect(JSON.parse(result.stdout).providers[0].source).toBe("local");
		expect(calls).toHaveLength(0);
	});

	test("Cloud failures are errors rather than an empty successful list", async () => {
		handler = () => jsonResponse({ detail: "Unavailable" }, 503);
		const result = await cli(["ai-provider", "list", "--json"]);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr.length).toBeGreaterThan(0);
	});

	test("edits Cloud with a sparse PATCH and synchronizes a matching local entry", async () => {
		seedCatalog();
		handler = (call) =>
			call.method === "GET"
				? jsonResponse({ providers: [provider] })
				: jsonResponse({ ...provider, label: "Updated" });
		const result = await cli([
			"ai-provider",
			"edit",
			"openai-main",
			"--label",
			"Updated",
			"--json",
		]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: "clawdi.aiProviderEdit.v1",
			updated: "openai-main",
			provider: { source: "cloud", label: "Updated" },
		});
		expect(calls[1]).toMatchObject({
			method: "PATCH",
			path: "/v1/ai-providers/openai-main",
			body: { label: "Updated" },
		});
		expect(
			JSON.parse(readFileSync(join(taskHome, ".clawdi/ai-providers/catalog.json"), "utf8"))
				.providers[0].label,
		).toBe("Updated");
	});

	test("Hosted impact requires explicit --yes before deletion", async () => {
		signIn(true);
		handler = (call) =>
			jsonResponse(call.path.endsWith("removal-impact") ? impact : { providers: [provider] });
		const result = await cli(["ai-provider", "remove", "openai-main", "--json"]);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("hdep_test");
		expect(result.stderr).toContain("--yes");
		expect(calls.every((call) => call.method === "GET")).toBe(true);
	});

	test("Hosted removal uses revision, incarnation and idempotency headers, then cleans local state", async () => {
		signIn(true);
		seedCatalog();
		handler = (call) =>
			jsonResponse(
				call.method === "DELETE"
					? { status: "removed", provider_id: "openai-main" }
					: call.path.endsWith("removal-impact")
						? impact
						: { providers: [provider] },
			);
		const result = await cli(["ai-provider", "remove", "openai-main", "--yes", "--json"]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: "clawdi.aiProviderRemove.v1",
			removed: "openai-main",
		});
		const deleted = calls.find((call) => call.method === "DELETE");
		expect(deleted?.path).toBe("/v2/ai-providers/openai-main");
		expect(deleted?.headers.get("Impact-Revision")).toBe(impact.impact_revision);
		expect(deleted?.headers.get("Provider-Incarnation")).toBe(impact.provider_incarnation_token);
		expect(deleted?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
		expect(
			JSON.parse(
				readFileSync(join(taskHome, ".clawdi/ai-providers/catalog.json"), "utf8"),
			).providers.map((item: { id: string }) => item.id),
		).toEqual(["local-only"]);
	});

	test("unsupported Hosted routes fall back to the Cloud web DELETE", async () => {
		signIn(true);
		handler = (call) =>
			call.path.endsWith("removal-impact")
				? jsonResponse({ detail: "Not found" }, 404)
				: jsonResponse(
						call.method === "GET"
							? { providers: [provider] }
							: { status: "deleted", provider_id: "openai-main" },
					);
		const result = await cli(["ai-provider", "remove", "openai-main", "--yes", "--json"]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(calls.find((call) => call.method === "DELETE")?.path).toBe(
			"/v1/ai-providers/openai-main",
		);
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: "clawdi.aiProviderRemove.v1",
			removed: "openai-main",
			source: "cloud",
		});
	});

	test("a rejected Hosted deletion preserves the local catalog", async () => {
		signIn(true);
		seedCatalog();
		handler = (call) =>
			call.method === "DELETE"
				? jsonResponse({ detail: "Impact changed" }, 409)
				: jsonResponse(call.path.endsWith("removal-impact") ? impact : { providers: [provider] });
		const result = await cli(["ai-provider", "remove", "openai-main", "--yes", "--json"]);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(
			JSON.parse(readFileSync(join(taskHome, ".clawdi/ai-providers/catalog.json"), "utf8"))
				.providers,
		).toHaveLength(2);
	});
});

describe("wallet reads", () => {
	test("a wallet API error produces stderr without an internal detail or JSON success", async () => {
		signIn(true);
		handler = () => jsonResponse({ detail: "INTERNAL_SERVER_DETAIL" }, 403);
		const result = await cli(["wallet", "usage", "--json"]);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("can't access the wallet");
		expect(result.stderr).not.toContain("INTERNAL_SERVER_DETAIL");
	});
	test("reads transactions with the web endpoint and limit", async () => {
		signIn(true);
		handler = () =>
			jsonResponse({
				items: [{ id: "txn-test", amount: "2.00" }],
				has_more: true,
				next_cursor: "next",
			});
		const result = await cli(["wallet", "transactions", "--limit", "20", "--json"]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: "clawdi.walletTransactions.v1",
			items: [{ id: "txn-test" }],
			next_cursor: "next",
		});
		expect(calls[0]).toMatchObject({ path: "/v2/wallet/transactions", query: "?limit=20" });
	});

	test("usage uses days and preserves the API period", async () => {
		signIn(true);
		handler = () =>
			jsonResponse({
				period_start: "2026-10-01",
				period_end: "2026-10-06",
				total_usd: "1.00",
				total_requests: 10,
				availability: "complete",
				by_day: [],
			});
		const result = await cli(["wallet", "usage", "--days", "7", "--json"]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: "clawdi.walletUsage.v1",
			period_start: "2026-10-01",
			period_end: "2026-10-06",
		});
		expect(calls[0]).toMatchObject({ path: "/v2/usage", query: "?days=7" });
	});

	test("omitted usage days leaves the API default intact", async () => {
		signIn(true);
		handler = () =>
			jsonResponse({
				period_start: "start",
				period_end: "end",
				total_usd: null,
				total_requests: null,
				availability: "unavailable",
				by_day: [],
			});
		const result = await cli(["wallet", "usage", "--json"]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(calls[0]?.query).toBe("");
	});

	test("rejects invalid numeric options before any request", async () => {
		for (const args of [
			["wallet", "usage", "--days", "0"],
			["wallet", "transactions", "--limit", "NaN"],
		]) {
			const result = await cli(args);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("positive integer");
		}
		expect(calls).toHaveLength(0);
	});

	test("portal prints the billing URL without making API writes", async () => {
		const result = await cli(["wallet", "portal"]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(result.stdout.trim()).toBe("https://cloud.clawdi.ai/?settings=billing-wallet");
		expect(calls).toHaveLength(0);
	});
});

describe("new Cloud commands", () => {
	test("new command help includes examples and the API's days parameter", async () => {
		for (const args of [
			["wallet", "transactions"],
			["wallet", "usage"],
			["wallet", "portal"],
			["channel", "unlink"],
			["channel", "unpair"],
			["vault", "request"],
			["skill", "show"],
		]) {
			const result = await cli([...args, "--help"]);
			expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
			expect(result.stdout).toContain("Example:");
			if (args[1] === "usage") {
				expect(result.stdout).toContain("--days <n>");
				expect(result.stdout).not.toContain("--since");
			}
		}
		expect(calls).toHaveLength(0);
	});

	test("skill show rejects unsafe keys before looking up a project", async () => {
		const result = await cli(["skill", "show", "../skill", "--json"]);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(calls).toHaveLength(0);
	});

	test("an expired vault request ends polling and reports a failure", async () => {
		handler = (call) =>
			jsonResponse(call.method === "POST" ? { ...created, status: "expired" } : vaultPage);
		const result = await cli([
			"vault",
			"request",
			"KEY",
			"--project",
			projectId,
			"--wait",
			"--json",
		]);
		expect(result.code).not.toBe(0);
		expect(JSON.parse(result.stdout).status).toBe("expired");
		expect(result.stderr).toContain("Create a new request");
		expect(calls.some((call) => call.path.startsWith("/v1/vault/requests/"))).toBe(false);
	});
	for (const [command, option, route, schema] of [
		["unlink", "--link", "agent-links", "clawdi.channelUnlink.v1"],
		["unpair", "--binding", "bindings", "clawdi.channelUnpair.v1"],
	]) {
		test(`${command} refuses non-TTY mutation without --yes and sends the exact DELETE with it`, async () => {
			handler = () => jsonResponse({ deleted: true });
			const args = ["channel", command, channelId, option, childId, "--json"];
			const refused = await cli(args);
			expect(refused.code).not.toBe(0);
			expect(refused.stdout).toBe("");
			expect(refused.stderr).toContain("--yes");
			expect(calls).toHaveLength(0);
			const result = await cli([...args, "--yes"]);
			expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
			expect(JSON.parse(result.stdout).schemaVersion).toBe(schema);
			expect(calls[0]).toMatchObject({
				method: "DELETE",
				path: `/v1/channels/${channelId}/${route}/${childId}`,
			});
		});
	}

	test("invalid channel UUID never reaches the server", async () => {
		const result = await cli([
			"channel",
			"unlink",
			"12345678",
			"--link",
			childId,
			"--yes",
			"--json",
		]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("valid UUID");
		expect(calls).toHaveLength(0);
	});

	test("skill show resolves the default project and reads the requested skill", async () => {
		handler = (call) =>
			jsonResponse(
				call.path.endsWith("default")
					? { project_id: projectId }
					: { skill_key: "team/skill", name: "Team skill", version: 1, content: "# Instructions" },
			);
		const result = await cli(["skill", "show", "team/skill", "--json"]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: "clawdi.skillShow.v1",
			project_id: projectId,
			skill: { content: "# Instructions" },
		});
		expect(calls[1]?.path).toBe(`/v1/projects/${projectId}/skills/team%2Fskill`);
	});

	test("vault request posts only names and prints the request capability, never values", async () => {
		handler = (call) => jsonResponse(call.method === "POST" ? created : vaultPage);
		const result = await cli([
			"vault",
			"request",
			"OPENAI_API_KEY",
			"--project",
			projectId,
			"--json",
		]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(result.stdout)).toMatchObject({
			schemaVersion: "clawdi.vaultRequest.v1",
			id: requestId,
			url: created.url,
			status: "pending",
		});
		expect(calls.find((call) => call.method === "POST")).toMatchObject({
			path: "/v1/vault/requests",
			body: {
				project_id: projectId,
				vault_id: vaultId,
				slug: "default",
				section: "",
				fields: ["OPENAI_API_KEY"],
			},
		});
		expect(result.stdout + result.stderr).not.toContain("NEVER_PRINT_SECRET");
	});

	test("vault wait polls to supplied with one JSON object and a usable URL on stderr", async () => {
		handler = (call) =>
			jsonResponse(
				call.method === "POST"
					? created
					: call.path.startsWith("/v1/vault/requests/")
						? { ...created, status: "supplied" }
						: vaultPage,
			);
		const result = await cli([
			"vault",
			"request",
			"OPENAI_API_KEY",
			"--project",
			projectId,
			"--wait",
			"--json",
		]);
		expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
		expect(JSON.parse(result.stdout).status).toBe("supplied");
		expect(result.stderr).toContain(created.url);
		expect(calls.at(-1)?.path).toBe(`/v1/vault/requests/${requestId}`);
		expect(result.stdout + result.stderr).not.toContain("NEVER_PRINT_SECRET");
	});

	test("all new commands require authentication before network access", async () => {
		rmSync(join(taskHome, ".clawdi/auth.json"));
		for (const args of [
			["wallet", "transactions", "--json"],
			["wallet", "usage", "--json"],
			["wallet", "portal"],
			["skill", "show", "skill", "--json"],
			["vault", "request", "KEY", "--json"],
			["channel", "unpair", channelId, "--binding", childId, "--yes", "--json"],
		]) {
			const result = await cli(args);
			expect(result.code).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Not signed in");
		}
		expect(calls).toHaveLength(0);
	});

	test("vault wait has a bounded timeout and exposes no secret values", async () => {
		const original = {
			HOME: process.env.HOME,
			CLAWDI_HOME: process.env.CLAWDI_HOME,
			CLAWDI_AUTH_TOKEN: process.env.CLAWDI_AUTH_TOKEN,
			CLAWDI_API_URL: process.env.CLAWDI_API_URL,
		};
		Object.assign(process.env, {
			HOME: taskHome,
			CLAWDI_HOME: join(taskHome, ".clawdi"),
			CLAWDI_AUTH_TOKEN: "",
			CLAWDI_API_URL: server.url.origin,
		});
		const mocked = mockFetch([
			{ method: "GET", path: /^\/v1\/vault\?/, response: () => jsonResponse(vaultPage) },
			{ method: "POST", path: "/v1/vault/requests", response: () => jsonResponse(created) },
			{
				method: "GET",
				path: `/v1/vault/requests/${requestId}`,
				response: () => jsonResponse(created),
			},
		]);
		const logs: string[] = [];
		const log = console.log;
		const error = console.error;
		console.log = (value: unknown) => {
			logs.push(String(value));
		};
		console.error = (value: unknown) => {
			logs.push(String(value));
		};
		let now = 0;
		try {
			await expect(
				vaultRequest(
					"KEY",
					{ project: projectId, wait: true, json: true },
					{
						now: () => now,
						sleep: async () => {
							now += 300000;
						},
					},
				),
			).rejects.toThrow("Timed out");
			expect(logs.join("\n")).not.toContain("NEVER_PRINT_SECRET");
			expect(mocked.captured.filter((call) => call.path.includes("/requests/")).length).toBe(0);
		} finally {
			console.log = log;
			console.error = error;
			mocked.restore();
			for (const [key, value] of Object.entries(original)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
