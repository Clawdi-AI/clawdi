import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentSkillsInstall,
	agentSkillsList,
	agentSkillsRead,
	agentSkillsRemove,
} from "../../src/commands/agent-skills";
import { setAuth } from "../../src/lib/config";
import { jsonResponse, mockFetch } from "./helpers";

const agentId = "123e4567-e89b-42d3-a456-426614174000";
const requestId = "123e4567-e89b-42d3-a456-426614174001";
const priorEnv: Record<string, string | undefined> = {};
let taskHome: string;
let originalLog: typeof console.log;
let priorExitCode: typeof process.exitCode;
let output: string[];

beforeEach(() => {
	for (const key of ["CLAWDI_HOME", "CLAWDI_API_URL", "CLAWDI_DEPLOY_API_URL"])
		priorEnv[key] = process.env[key];
	taskHome = mkdtempSync(join(tmpdir(), "clawdi-remote-skills-"));
	process.env.CLAWDI_HOME = taskHome;
	process.env.CLAWDI_API_URL = "https://cloud.example.test";
	process.env.CLAWDI_DEPLOY_API_URL = "https://hosted.example.test";
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	setAuth({
		authType: "clerk_oauth",
		apiKey: `${encode({ typ: "at+jwt" })}.${encode({ sub: "user" })}.signature`,
		refreshToken: "test-refresh",
		accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
		issuer: "https://clerk.example.test",
		clientId: "test-client",
		audience: "clawdi-api",
		tokenEndpoint: "https://clerk.example.test/oauth/token",
		scopes: ["openid"],
		subject: "user",
		userId: "user",
		endpointBinding: {
			version: 1,
			cloudApiOrigin: "https://cloud.example.test",
			hostedApiOrigin: "https://hosted.example.test",
		},
	});
	originalLog = console.log;
	priorExitCode = process.exitCode ?? 0;
	output = [];
	console.log = (...values: unknown[]) => output.push(values.join(" "));
});

afterEach(() => {
	console.log = originalLog;
	process.exitCode = priorExitCode;
	for (const [key, value] of Object.entries(priorEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(taskHome, { recursive: true, force: true });
});

function hostedHandlers(available = true) {
	return [
		{
			method: "GET",
			path: /^\/v2\/deployments$/,
			response: () =>
				jsonResponse([
					{
						agent_id: agentId,
						resource: { id: "hdep-owned", spec: { desired_lifecycle: "running" } },
					},
					{
						agent_id: "other",
						clawdi_cloud_environments: { hermes: agentId },
						resource: { id: "hdep-wrong", spec: { desired_lifecycle: "running" } },
					},
				]),
		},
		{
			method: "GET",
			path: /^\/v2\/deployments\/hdep-owned\/workspace-skills$/,
			response: () =>
				jsonResponse({
					deployment_resource_version: "rv_current",
					capability: { available, reason: available ? "available" : "upgrade_not_observed" },
					items: [{ skill_key: "review", status: "requested" }],
				}),
		},
	];
}

test("GitHub requests use stable Agent identity, original replay version and surface failure", async () => {
	const { captured, restore } = mockFetch([
		...hostedHandlers(),
		{
			method: "POST",
			path: "/v2/deployments/hdep-owned/workspace-skills",
			response: () =>
				jsonResponse({
					skill_key: "review",
					desired_state: "present",
					status: "failed",
					failure_message: "Native validation failed",
				}),
		},
	]);
	try {
		await agentSkillsInstall(agentId, {
			github: "owner/repo",
			path: "skills/review",
			requestId,
			resourceVersion: "rv_original",
			json: true,
		});
		const mutation = captured.find((item) => item.method === "POST");
		expect(mutation?.headers["if-match"]).toBe('"rv_original"');
		expect(mutation?.headers["idempotency-key"]).toBe(requestId);
		expect(mutation?.body).toEqual({ repo: "owner/repo", path: "skills/review" });
		expect(process.exitCode).toBe(1);
		expect(JSON.parse(output[0] ?? "")).toMatchObject({
			status: "failed",
			request_id: requestId,
			request_resource_version: "rv_original",
		});
	} finally {
		restore();
	}
});

test("unavailable GitHub capability and conflicting source flags cannot mutate", async () => {
	const { captured, restore } = mockFetch(hostedHandlers(false));
	try {
		await expect(
			agentSkillsInstall(agentId, { github: "owner/repo", library: "library-id" }),
		).rejects.toThrow("exactly one");
		expect(captured).toHaveLength(0);
		await expect(agentSkillsInstall(agentId, { github: "owner/repo" })).rejects.toThrow(
			"upgrade_not_observed",
		);
		expect(captured.every((item) => item.method === "GET")).toBe(true);
	} finally {
		restore();
	}
});

test("Library install/read/remove follows Cloud authority and protects linked Skills", async () => {
	const { captured, restore } = mockFetch([
		{
			method: "PUT",
			path: `/v1/agents/${agentId}/skill-references/library-id`,
			response: () =>
				jsonResponse({ agent_id: agentId, skill_id: "library-id", desired_state: "present" }, 202),
		},
		{
			method: "GET",
			path: `/v1/agents/${agentId}/skills`,
			response: () =>
				jsonResponse({
					agent_id: agentId,
					skills: [
						{
							skill_key: "library-review",
							authority: "cloud",
							source: "library",
							skill_id: "library-id",
							project_id: "project-id",
							source_skill_key: "review",
							read_only: false,
						},
						{ skill_key: "linked", authority: "cloud", source: "project", read_only: true },
					],
				}),
		},
		{
			method: "GET",
			path: "/v1/projects/project-id/skills/review",
			response: () => jsonResponse({ content: "# Review\nUse instructions" }),
		},
		{
			method: "DELETE",
			path: `/v1/agents/${agentId}/skill-references/library-id`,
			response: () => jsonResponse({ desired_state: "absent" }, 202),
		},
	]);
	try {
		await agentSkillsInstall(agentId, { library: "library-id", json: true });
		await agentSkillsRead(agentId, "library-review", { json: true });
		await agentSkillsRemove(agentId, "library-review", { json: true });
		await expect(agentSkillsRemove(agentId, "linked")).rejects.toThrow("cannot be removed");
		expect(captured.filter((item) => item.method === "DELETE")).toHaveLength(1);
		expect(
			captured.every((item) => new URL(item.url).origin === "https://cloud.example.test"),
		).toBe(true);
		expect(JSON.parse(output[0] ?? "").status).toBe("accepted");
		expect(JSON.parse(output[1] ?? "").detail.content).toContain("Use instructions");
	} finally {
		restore();
	}
});

test("list exposes failed removals and sets failure exit status without claiming installation", async () => {
	const { restore } = mockFetch([
		...hostedHandlers(),
		{
			method: "GET",
			path: `/v1/agents/${agentId}/skills`,
			response: () =>
				jsonResponse({
					agent_id: agentId,
					skills: [],
					removal_failures: [{ skill_key: "removed", observation_error_code: "reconcile_failed" }],
				}),
		},
	]);
	try {
		await agentSkillsList(agentId, { json: true });
		expect(process.exitCode).toBe(1);
		expect(JSON.parse(output[0] ?? "").removal_failures).toEqual([
			{ skill_key: "removed", observation_error_code: "reconcile_failed" },
		]);
	} finally {
		restore();
	}
});
