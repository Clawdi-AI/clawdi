import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	components,
	DeployComponents,
	Deployment,
	HostedDeployOperation,
} from "@clawdi/shared/api";
import { hostedDeploymentFixture } from "../../../shared/src/view/hosted-deployment.test-fixture";

const entry = resolve(import.meta.dir, "../../src/index.ts");
const agentId = "123e4567-e89b-42d3-a456-426614174000";
const sessionId = "123e4567-e89b-42d3-a456-426614174001";
const deploymentId = "hdep_owned";
const operationName = "operations/hop_owned";
const agent: components["schemas"]["AgentResponse"] = {
	id: agentId,
	name: "Default agent name",
	display_name: "My laptop",
	machine_id: "test-machine",
	machine_name: "Test Mac",
	agent_type: "codex",
	agent_version: "1.0.0",
	os: "darwin",
	sort_order: 0,
	last_seen_at: "2026-10-06T12:00:00Z",
	queue_depth_high_water: 0,
	dropped_count: 0,
	sync_enabled: true,
	explicit_identity: false,
	default_project_id: "123e4567-e89b-42d3-a456-426614174002",
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const accessToken = `${encode({ typ: "at+jwt" })}.${encode({ sub: "test-user" })}.signature`;
let taskHome: string;
let server: Bun.Server<undefined>;
let requests: { method: string; path: string; authorization: string | null }[];
let status: number;
let agents: components["schemas"]["AgentResponse"][];
let deployments: Deployment[];
let deploymentStatus: number;
let mutationStatus: number;
let operationPolls: number;
let operationFails: boolean;
let initiallyDone: boolean;
let deleteConverged: boolean;
let plugins: components["schemas"]["AgentPluginDesiredStateResponse"][];
let catalog: components["schemas"]["PluginCatalogResponse"];
let mutations: {
	method: string;
	path: string;
	ifMatch: string | null;
	requestId: string | null;
	body: unknown;
}[];

const subscription: DeployComponents["schemas"]["V2HostedComputeSubscriptionInfo"] = {
	status: "active",
	funding_source: "wallet",
	payment_state: "ok",
	billing_term_months: 1,
	price_cents: 1000,
	currency: "usd",
	cancel_at_period_end: false,
};
const plugin: components["schemas"]["AgentPluginDesiredStateResponse"] = {
	installation_id: sessionId,
	agent_id: agentId,
	plugin_name: "review",
	version: "1.2.3",
	catalog_revision: "rev_test",
	desired_state: "present",
	convergence: "not_observed",
	created_at: "2026-10-06T12:00:00Z",
	updated_at: "2026-10-06T12:00:00Z",
};

function operation(
	done: boolean,
	verb: HostedDeployOperation["metadata"]["verb"] = "restart",
): HostedDeployOperation {
	return {
		name: operationName,
		metadata: {
			"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
			deploymentId,
			verb,
			targetGeneration: 2,
			manifestETag: "etag_next",
			createTime: "2026-10-06T12:00:00Z",
			updateTime: "2026-10-06T12:00:00Z",
		},
		done,
		error:
			done && operationFails ? { code: 13, message: "Internal test detail", details: [] } : null,
	};
}

beforeEach(() => {
	taskHome = mkdtempSync(join(tmpdir(), "clawdi-cloud-resources-"));
	requests = [];
	status = 204;
	agents = [agent];
	deployments = [];
	deploymentStatus = 200;
	mutationStatus = 202;
	operationPolls = 0;
	operationFails = false;
	initiallyDone = false;
	deleteConverged = false;
	mutations = [];
	plugins = [plugin];
	catalog = {
		revision: "rev_test",
		synced_at: "2026-10-06T12:00:00Z",
		plugins: [
			{
				name: "review",
				version: "1.2.3",
				display_name: "Review plugin",
				category: "development",
				keywords: [],
				languages: [],
				runtimes: ["hermes"],
				components: { skills: [], mcpServers: {} },
				installable: true,
			},
		],
	};
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			requests.push({
				method: request.method,
				path,
				authorization: request.headers.get("authorization"),
			});
			if (request.method === "GET" && path === "/v1/agents") return Response.json(agents);
			if (request.method === "GET" && path === "/v2/deployments")
				return Response.json(
					deploymentStatus === 200 ? deployments : { detail: "Internal test detail" },
					{ status: deploymentStatus },
				);
			if (request.method === "GET" && path === `/v2/${operationName}`) {
				operationPolls += 1;
				return Response.json(operation(operationPolls >= 2));
			}
			if (request.method === "GET" && path === "/v1/plugin-catalog") return Response.json(catalog);
			if (request.method === "GET" && path === `/v1/agents/${agentId}/agent-plugins`)
				return Response.json({ plugins });
			if (
				path.startsWith(`/v2/deployments/${deploymentId}`) ||
				path === `/v1/agents/${agentId}/agent-plugins/review`
			) {
				mutations.push({
					method: request.method,
					path,
					ifMatch: request.headers.get("if-match"),
					requestId: request.headers.get("idempotency-key"),
					body: await request.text().then((body) => (body ? JSON.parse(body) : null)),
				});
				if (mutationStatus !== 202)
					return Response.json({ detail: "Internal test detail" }, { status: mutationStatus });
				if (path.startsWith("/v2/")) {
					if (deleteConverged && request.method === "DELETE")
						return Response.json({ deployment_id: deploymentId, status: "absent" });
					return Response.json(operation(initiallyDone), { status: 202 });
				}
				return Response.json(
					request.method === "PUT"
						? plugin
						: {
								agent_id: agentId,
								plugin_name: "review",
								desired_state: "absent",
								convergence: "not_observed",
							},
					{ status: 202 },
				);
			}
			if (
				request.method === "DELETE" &&
				(path.toLowerCase() === `/v1/agents/${agentId}` || path === `/v1/sessions/${sessionId}`)
			) {
				return status === 204
					? new Response(null, { status })
					: Response.json({ detail: "Internal test detail must not reach the user" }, { status });
			}
			return Response.json({ detail: "Unexpected test request" }, { status: 404 });
		},
	});
	mkdirSync(join(taskHome, ".clawdi"));
	writeFileSync(
		join(taskHome, ".clawdi", "auth.json"),
		JSON.stringify({
			authType: "clerk_oauth",
			apiKey: accessToken,
			refreshToken: "test-refresh",
			accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			issuer: "https://clerk.example.test",
			clientId: "test-client",
			audience: "clawdi-api",
			tokenEndpoint: "https://clerk.example.test/oauth/token",
			scopes: ["openid"],
			subject: "test-user",
			userId: "test-user",
			endpointBinding: {
				version: 1,
				cloudApiOrigin: server.url.origin,
				hostedApiOrigin: server.url.origin,
			},
		}),
	);
});

afterEach(async () => {
	await server.stop(true);
	rmSync(taskHome, { recursive: true, force: true });
});

async function runCli(args: string[], deployApiUrl = server.url.origin) {
	const child = Bun.spawn([process.execPath, entry, ...args], {
		cwd: taskHome,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 10_000,
		killSignal: "SIGKILL",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: taskHome,
			CI: "1",
			NO_COLOR: "1",
			CLAWDI_RUNTIME_MODE: "local",
			CLAWDI_API_URL: server.url.origin,
			CLAWDI_DEPLOY_API_URL: deployApiUrl,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
		},
	});
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(child.signalCode).toBeNull();
		return { stdout, stderr, code };
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
}

describe("agent list", () => {
	it("lists Cloud agents as JSON using OAuth authentication", async () => {
		const result = await runCli(["agent", "list", "--json"]);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const payload = JSON.parse(result.stdout);
		expect(payload.schemaVersion).toBe("clawdi.agentList.v1");
		expect(payload.agents).toEqual([
			{
				id: agentId,
				name: "Default agent name",
				display_name: "My laptop",
				agent_type: "codex",
				machine_name: "Test Mac",
				last_seen_at: "2026-10-06T12:00:00Z",
				kind: "local",
				deployment_status: null,
			},
		]);
		expect(requests).toEqual([
			{ method: "GET", path: "/v1/agents", authorization: `Bearer ${accessToken}` },
			{ method: "GET", path: "/v2/deployments", authorization: `Bearer ${accessToken}` },
		]);
	});

	it("aligns columns for different lengths while preserving full IDs and safe names", async () => {
		const secondAgentId = "123e4567-e89b-42d3-a456-426614174003";
		agents = [
			{ ...agent, display_name: "My\x1b[31m laptop" },
			{
				...agent,
				id: secondAgentId,
				name: "Long workstation agent name",
				display_name: null,
				agent_type: "claude_code",
				machine_name: "Build workstation",
				last_seen_at: null,
			},
		];
		const result = await runCli(["agent", "list"]);
		expect(result.code).toBe(0);
		const [header = "", ...rows] = result.stdout.trimEnd().split("\n");
		const columns = ["ID", "Name", "Type", "Machine", "Last activity"];
		for (const column of columns) expect(header).toContain(column);
		expect(rows).toHaveLength(2);
		const expectedRows = [
			[agentId, "My laptop", "codex", "Test Mac", "2026-10-06T12:00:00Z"],
			[secondAgentId, "Long workstation agent name", "claude_code", "Build workstation", "Never"],
		];
		for (const [rowIndex, fields] of expectedRows.entries()) {
			const row = rows[rowIndex] ?? "";
			for (const [columnIndex, field] of fields.entries()) {
				expect(row).toContain(field);
				expect(row.indexOf(field)).toBe(header.indexOf(columns[columnIndex] ?? ""));
			}
		}
		expect(result.stdout).not.toContain("\x1b");
		expect(result.stderr).toBe("");
	});

	it("reports an empty inventory in both formats", async () => {
		agents = [];
		const json = await runCli(["agent", "list", "--json"]);
		expect(json.code).toBe(0);
		const payload = JSON.parse(json.stdout);
		expect(payload.schemaVersion).toBe("clawdi.agentList.v1");
		expect(payload.agents).toEqual([]);
		const text = await runCli(["agent", "list"]);
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("No agents found.");
	});
});

for (const command of [
	{
		name: "agent",
		id: agentId,
		path: `/v1/agents/${agentId}`,
		schemaVersion: "clawdi.agentRm.v1",
		status: "disconnected",
	},
	{
		name: "session",
		id: sessionId,
		path: `/v1/sessions/${sessionId}`,
		schemaVersion: "clawdi.sessionRm.v1",
		status: "deleted",
	},
]) {
	describe(`${command.name} rm`, () => {
		it.each(["local-session-id", "", "../other", `${command.id}/permissions`, "123e4567"])(
			"rejects invalid UUID %j before contacting the API",
			async (id) => {
				const result = await runCli([command.name, "rm", id, "--yes", "--json"]);
				expect(result.code).toBe(1);
				expect(result.stderr).toContain("must be a valid UUID");
				expect(result.stdout).toBe("");
				expect(requests).toEqual([]);
			},
		);

		it("requires an ID", async () => {
			const result = await runCli([command.name, "rm", "--yes"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("missing required argument");
			expect(requests).toEqual([]);
		});

		it("requires confirmation in a non-interactive shell", async () => {
			const result = await runCli([command.name, "rm", command.id, "--json"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Confirmation required");
			expect(result.stderr).toContain("--yes");
			if (command.name === "session") {
				expect(result.stderr).toContain("permanently delete this uploaded session");
			}
			expect(result.stdout).toBe("");
			expect(requests).toEqual([]);
		});

		it.each(["-y", "--yes"])("deletes the exact Cloud resource with %s", async (flag) => {
			const result = await runCli([command.name, "rm", command.id, flag, "--json"]);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			const payload = JSON.parse(result.stdout);
			expect(payload.schemaVersion).toBe(command.schemaVersion);
			expect(payload).toEqual({
				schemaVersion: command.schemaVersion,
				id: command.id,
				status: command.status,
			});
			expect(requests).toEqual([
				{ method: "DELETE", path: command.path, authorization: `Bearer ${accessToken}` },
			]);
		});

		it.each([403, 404, 503])("reports HTTP %i safely on stderr", async (code) => {
			status = code;
			const result = await runCli([command.name, "rm", command.id, "--yes", "--json"]);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toContain("Internal test detail");
			if (code === 403) expect(result.stderr).toContain("clawdi auth login");
			if (code === 404) expect(result.stderr).toContain("not found");
			if (code === 503) expect(result.stderr).toContain("Please retry");
		});
	});
}

it("requires authentication for all three commands", async () => {
	unlinkSync(join(taskHome, ".clawdi", "auth.json"));
	for (const args of [
		["agent", "list", "--json"],
		["agent", "rm", agentId, "--yes"],
		["session", "rm", sessionId, "--yes"],
	]) {
		const result = await runCli(args);
		expect(result.code).toBe(4);
		expect(result.stderr).toContain("clawdi auth login");
		expect(result.stdout).toBe("");
	}
	expect(requests).toEqual([]);
});

it("shows the new commands under agent and session help", async () => {
	for (const name of ["agent", "session"]) {
		const result = await runCli([name, "--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`rm [options] <${name}-id>`);
		if (name === "agent") expect(result.stdout).toContain("List your agents");
		else expect(result.stdout).toContain("Permanently delete an uploaded session");
	}
	expect(requests).toEqual([]);
});

describe("Cloud Agent deployment inventory", () => {
	it("returns unknown deployment fields when the deploy API cannot be reached", async () => {
		const unavailable = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(null),
		});
		const deployApiUrl = unavailable.url.origin;
		await unavailable.stop(true);
		const authPath = join(taskHome, ".clawdi", "auth.json");
		const auth = JSON.parse(readFileSync(authPath, "utf8"));
		auth.endpointBinding.hostedApiOrigin = deployApiUrl;
		writeFileSync(authPath, JSON.stringify(auth));
		const result = await runCli(["agent", "list", "--json"], deployApiUrl);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).agents).toMatchObject([
			{ id: agentId, kind: null, deployment_status: null },
		]);
		expect(result.stderr).toContain("deployment status");
	});

	it("joins stable agent identities and observed status without using projection IDs", async () => {
		const cloudId = "123e4567-e89b-42d3-a456-426614174004";
		agents.push({ ...agent, id: cloudId, agent_type: "hermes" });
		deployments = [
			hostedDeploymentFixture({
				agentId: cloudId,
				status: "stopped",
				cloudEnvironments: { hermes: agentId },
			}),
		];
		const result = await runCli(["agent", "list", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).agents).toMatchObject([
			{ id: agentId, kind: "local", deployment_status: null },
			{ id: cloudId, kind: "cloud", deployment_status: "stopped" },
		]);
		const human = await runCli(["agent", "list"]);
		expect(human.stdout).toContain("Deployment status");
		expect(human.stdout).toContain("cloud");
		expect(human.stdout).toContain("stopped");
		expect(human.stdout).toContain(cloudId);
	});

	it.each([503, 403])("keeps results when deployment API returns HTTP %i", async (code) => {
		deploymentStatus = code;
		const result = await runCli(["agent", "list", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).agents).toMatchObject([
			{ id: agentId, kind: null, deployment_status: null },
		]);
		expect(result.stderr).toContain("deployment status");
		expect(result.stderr).not.toContain("Internal test detail");
		const human = await runCli(["agent", "list"]);
		expect(human.stdout.trimEnd()).toMatch(/-\s+-$/);
	});
});

describe("Cloud Agent lifecycle", () => {
	beforeEach(() => {
		deployments = [
			hostedDeploymentFixture({ id: deploymentId, agentId, resourceVersion: "rv_current" }),
		];
	});

	it("accepts a valid uppercase Agent UUID", async () => {
		const result = await runCli(["agent", "restart", agentId.toUpperCase(), "--no-wait", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).deployment_id).toBe(deploymentId);
		expect(mutations).toHaveLength(1);
	});

	it.each(["start", "stop", "restart"])(
		"%s waits for the exact accepted operation",
		async (action) => {
			const result = await runCli(["agent", action, agentId, "--json"]);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({
				schemaVersion: `clawdi.agent${action[0]?.toUpperCase()}${action.slice(1)}.v1`,
				id: agentId,
				deployment_id: deploymentId,
				operation_name: operationName,
				status: "succeeded",
			});
			expect(operationPolls).toBe(2);
			expect(result.stderr).toContain("Waiting");
			expect(mutations).toHaveLength(1);
			expect(mutations[0]).toMatchObject({
				method: "POST",
				path: `/v2/deployments/${deploymentId}/${action}`,
				ifMatch: '"rv_current"',
				body: null,
			});
			expect(mutations[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
			expect(requests.every((request) => request.authorization === `Bearer ${accessToken}`)).toBe(
				true,
			);
		},
	);

	it.each(["start", "stop", "restart"])(
		"%s --no-wait returns acceptance without polling",
		async (action) => {
			const result = await runCli(["agent", action, agentId, "--no-wait", "--json"]);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout).status).toBe("accepted");
			expect(operationPolls).toBe(0);
			expect(result.stderr).toBe("");
		},
	);

	it("accepts an already completed operation without polling", async () => {
		initiallyDone = true;
		const result = await runCli(["agent", "stop", agentId, "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).status).toBe("succeeded");
		expect(operationPolls).toBe(0);
	});

	it("reports operation failure without leaking internal errors", async () => {
		operationFails = true;
		const result = await runCli(["agent", "restart", agentId, "--json"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("failed");
		expect(result.stderr).toContain(operationName);
		expect(result.stderr).not.toContain("Internal test detail");
	});

	it.each([409, 412, 503])("does not retry a lifecycle mutation after HTTP %i", async (code) => {
		mutationStatus = code;
		const result = await runCli(["agent", "start", agentId, "--json"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("Internal test detail");
		expect(mutations).toHaveLength(1);
	});

	it.each([401, 403])("maps Hosted authorization HTTP %i correctly", async (code) => {
		deploymentStatus = code;
		const result = await runCli(["agent", "start", agentId, "--json"]);
		expect(result.code).toBe(code === 401 ? 4 : 1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Cloud Agent authorization required");
		expect(result.stderr).not.toContain("Internal test detail");
		expect(mutations).toEqual([]);
	});

	it("uses authorization exit code for a Hosted sign-in error", async () => {
		const authPath = join(taskHome, ".clawdi", "auth.json");
		const auth = JSON.parse(readFileSync(authPath, "utf8"));
		auth.endpointBinding.hostedApiOrigin = "http://127.0.0.1:9";
		writeFileSync(authPath, JSON.stringify(auth));
		const result = await runCli(["agent", "start", agentId, "--json"]);
		expect(result.code).toBe(4);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("sign-in");
		expect(requests).toEqual([]);
	});

	it.each(["local", "deleted", "ambiguous", "projection"])(
		"rejects a %s mapping before mutation",
		async (kind) => {
			if (kind === "local") deployments = [];
			if (kind === "deleted")
				deployments = [hostedDeploymentFixture({ agentId, desiredLifecycle: "deleted" })];
			if (kind === "ambiguous") deployments.push(hostedDeploymentFixture({ agentId }));
			if (kind === "projection")
				deployments = [hostedDeploymentFixture({ cloudEnvironments: { hermes: agentId } })];
			const result = await runCli(["agent", "restart", agentId, "--json"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("isn't an active Cloud Agent");
			expect(result.stdout).toBe("");
			expect(mutations).toEqual([]);
		},
	);

	it.each(["start", "stop", "restart"])(
		"validates %s UUIDs before making requests",
		async (action) => {
			const result = await runCli(["agent", action, "hermes", "--json"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("must be a valid UUID");
			expect(requests).toEqual([]);
		},
	);
});

describe("Cloud Agent removal", () => {
	beforeEach(() => {
		status = 409;
		deployments = [
			hostedDeploymentFixture({
				id: deploymentId,
				agentId,
				resourceVersion: "rv_current",
				computeSubscription: subscription,
			}),
		];
	});

	it("maps an uppercase Agent UUID to the Cloud deployment", async () => {
		const result = await runCli([
			"agent",
			"rm",
			agentId.toUpperCase(),
			"--yes",
			"--keep-subscription",
			"--json",
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).deployment_id).toBe(deploymentId);
		expect(mutations).toHaveLength(1);
	});

	for (const yes of [false, true]) {
		for (const flags of [
			[],
			["--cancel-subscription"],
			["--keep-subscription"],
			["--cancel-subscription", "--keep-subscription"],
		]) {
			it(`requires the subscription and confirmation choices: yes=${yes}, flags=${flags.join(",")}`, async () => {
				const result = await runCli([
					"agent",
					"rm",
					agentId,
					"--json",
					...(yes ? ["--yes"] : []),
					...flags,
				]);
				const allowed = yes && flags.length === 1;
				expect(result.code).toBe(allowed ? 0 : 1);
				if (allowed) {
					expect(JSON.parse(result.stdout)).toEqual({
						schemaVersion: "clawdi.agentRm.v1",
						id: agentId,
						status: "accepted",
						deployment_id: deploymentId,
						operation_name: operationName,
						subscription_choice:
							flags[0] === "--cancel-subscription" ? "cancel_subscription" : "keep_subscription",
					});
					expect(mutations).toHaveLength(1);
					expect(mutations[0]).toMatchObject({
						method: "DELETE",
						path: `/v2/deployments/${deploymentId}`,
						ifMatch: '"rv_current"',
						body: {
							subscription_choice:
								flags[0] === "--cancel-subscription" ? "cancel_subscription" : "keep_subscription",
						},
					});
					expect(mutations[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
				} else {
					expect(result.stdout).toBe("");
					expect(mutations).toEqual([]);
					if (flags.length === 2) expect(result.stderr).toContain("not both");
					else if (!yes) {
						expect(result.stderr).toContain("Confirmation required");
						expect(result.stderr).toContain("permanently delete a Cloud Agent and its saved data");
						expect(requests).toEqual([]);
					} else expect(result.stderr).toContain("renewing subscription");
				}
			});
		}
	}

	it.each(["included", "canceling", "unfunded", "unpaid"])(
		"mirrors web defaults for %s subscriptions",
		async (kind) => {
			deployments = [
				hostedDeploymentFixture({
					id: deploymentId,
					agentId,
					currentPlanSlug: kind === "included" ? "compute_basic" : "compute_performance",
					computeSubscription:
						kind === "unfunded"
							? null
							: {
									...subscription,
									...(kind === "included"
										? { funding_source: null, price_cents: 0 }
										: kind === "unpaid"
											? { payment_state: "unpaid" }
											: { cancel_at_period_end: true }),
								},
				}),
			];
			deleteConverged = true;
			const result = await runCli(["agent", "rm", agentId, "--yes", "--json"]);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				status: "deleted",
				operation_name: null,
				subscription_choice: kind === "included" ? "cancel_subscription" : "keep_subscription",
			});
		},
	);

	it.each(["trialing", "past_due"])(
		"requires a choice for a renewing %s subscription",
		async (subscriptionStatus) => {
			deployments = [
				hostedDeploymentFixture({
					id: deploymentId,
					agentId,
					computeSubscription: { ...subscription, status: subscriptionStatus },
				}),
			];
			const result = await runCli(["agent", "rm", agentId, "--yes", "--json"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("renewing subscription");
			expect(mutations).toEqual([]);
		},
	);

	it("does not replace the local delete result when the deployment API is unavailable", async () => {
		status = 204;
		deploymentStatus = 503;
		const result = await runCli(["agent", "rm", agentId, "--yes", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).status).toBe("disconnected");
		expect(requests.map((request) => request.path)).toEqual([`/v1/agents/${agentId}`]);
	});

	it.each([412, 503])("reports Cloud deletion HTTP %i without leaking details", async (code) => {
		mutationStatus = code;
		const result = await runCli(["agent", "rm", agentId, "--yes", "--keep-subscription", "--json"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("Internal test detail");
		expect(mutations).toHaveLength(1);
	});
});

describe("agent plugins", () => {
	it("lists requested state and convergence in a versioned envelope", async () => {
		const result = await runCli(["agent", "plugins", "list", agentId, "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			schemaVersion: "clawdi.agentPluginsList.v1",
			agent_id: agentId,
			plugins: [plugin],
		});
		expect(result.stderr).toBe("");
		const human = await runCli(["agent", "plugins", "list", agentId]);
		expect(human.stdout).toContain("review  1.2.3  not_observed");
		expect(() => JSON.parse(human.stdout)).toThrow();
	});

	it("surfaces failed convergence in both formats", async () => {
		plugins = [{ ...plugin, convergence: "failed", observation_error_code: "receipt_mismatch" }];
		const result = await runCli(["agent", "plugins", "list", agentId, "--json"]);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout).plugins[0].convergence).toBe("failed");
		const human = await runCli(["agent", "plugins", "list", agentId]);
		expect(human.code).toBe(1);
		expect(human.stderr).toContain("receipt_mismatch");
	});

	it("uses catalog versions to request an installation without claiming runtime application", async () => {
		const result = await runCli([
			"agent",
			"plugins",
			"install",
			agentId,
			"review",
			"--plugin-version",
			"1.2.3",
			"--json",
		]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			schemaVersion: "clawdi.agentPluginsInstall.v1",
			status: "accepted",
			...plugin,
		});
		expect(requests.map((request) => [request.method, request.path])).toEqual([
			["GET", "/v1/plugin-catalog"],
			["PUT", `/v1/agents/${agentId}/agent-plugins/review`],
		]);
		expect(mutations[0]?.body).toEqual({ version: "1.2.3" });
	});

	it("prints install choices on stderr when no name is supplied non-interactively", async () => {
		const result = await runCli(["agent", "plugins", "install", agentId, "--json"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("review");
		expect(result.stdout).toBe("");
		expect(mutations).toEqual([]);
	});

	it.each(["missing", "uninstallable", "version"])(
		"rejects a %s catalog choice before mutation",
		async (kind) => {
			if (kind === "uninstallable")
				catalog.plugins = catalog.plugins.map((entry) => ({ ...entry, installable: false }));
			const result = await runCli([
				"agent",
				"plugins",
				"install",
				agentId,
				kind === "missing" ? "other" : "review",
				...(kind === "version" ? ["--plugin-version", "9.0.0"] : []),
				"--json",
			]);
			expect(result.code).toBe(1);
			expect(result.stdout).toBe("");
			expect(mutations).toEqual([]);
		},
	);

	it("requires --yes for removal and reports requested absence", async () => {
		const denied = await runCli(["agent", "plugins", "rm", agentId, "review", "--json"]);
		expect(denied.code).toBe(1);
		expect(denied.stderr).toContain("--yes");
		expect(requests).toEqual([]);
		const result = await runCli(["agent", "plugins", "rm", agentId, "review", "--yes", "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			schemaVersion: "clawdi.agentPluginsRm.v1",
			status: "accepted",
			agent_id: agentId,
			plugin_name: "review",
			desired_state: "absent",
			convergence: "not_observed",
		});
		expect(mutations[0]?.method).toBe("DELETE");
	});

	it.each(["../other", "review/more", "bad--name", "name."])(
		"rejects invalid plugin name %j before API calls",
		async (name) => {
			const result = await runCli(["agent", "plugins", "rm", agentId, name, "--yes"]);
			expect(result.code).toBe(1);
			expect(requests).toEqual([]);
		},
	);

	it.each([403, 404, 409, 503])("reports plugin mutation HTTP %i safely", async (code) => {
		mutationStatus = code;
		const result = await runCli(["agent", "plugins", "install", agentId, "review", "--json"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("Internal test detail");
	});
});

it("requires auth and valid UUIDs for all lifecycle and plugin commands", async () => {
	const commands = [
		["agent", "start", agentId],
		["agent", "stop", agentId],
		["agent", "restart", agentId],
		["agent", "plugins", "list", agentId],
		["agent", "plugins", "install", agentId, "review"],
		["agent", "plugins", "rm", agentId, "review", "--yes"],
	];
	for (const command of commands) {
		const invalid = command.map((arg) => (arg === agentId ? "hermes" : arg));
		const result = await runCli(invalid);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("must be a valid UUID");
	}
	unlinkSync(join(taskHome, ".clawdi", "auth.json"));
	for (const command of commands) {
		const result = await runCli(command);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("clawdi auth login");
		expect(result.stdout).toBe("");
	}
	expect(requests).toEqual([]);
});

it("documents examples and options for all new subcommands", async () => {
	for (const subcommand of [
		["start"],
		["stop"],
		["restart"],
		["rm"],
		["plugins", "list"],
		["plugins", "install"],
		["plugins", "rm"],
	]) {
		const result = await runCli(["agent", ...subcommand, "--help"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Example: clawdi agent");
		expect(result.stdout).toContain("--json");
	}
	expect(requests).toEqual([]);
});
