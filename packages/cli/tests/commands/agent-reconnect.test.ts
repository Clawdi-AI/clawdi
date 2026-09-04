import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentReconnect } from "../../src/commands/agent-reconnect";
import { jsonResponse, mockFetch } from "./helpers";

const tmpRoot = mkdtempSync(join(tmpdir(), "clawdi-agent-reconnect-test-"));
const ENV_KEYS = ["CI", "HOME", "CLAWDI_API_URL", "PI_CODING_AGENT_DIR"] as const;

let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let home = "";
let restoreFetch: (() => void) | null = null;
let restoreConsole: (() => void) | null = null;
let output: string[] = [];

afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
	home = mkdtempSync(join(tmpRoot, "case-"));
	envSnapshot = {};
	for (const key of ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) envSnapshot[key] = value;
		delete process.env[key];
	}
	process.env.CI = "1";
	process.env.HOME = home;
	process.env.CLAWDI_API_URL = "https://api.test";
	process.env.PI_CODING_AGENT_DIR = join(home, "pi-agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	seedOAuthAuth();

	const originalLog = console.log;
	const originalError = console.error;
	output = [];
	console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
	console.error = (...values: unknown[]) => output.push(values.map(String).join(" "));
	restoreConsole = () => {
		console.log = originalLog;
		console.error = originalError;
	};
	process.exitCode = 0;
});

afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
	restoreConsole?.();
	restoreConsole = null;
	process.exitCode = 0;
	for (const key of ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(envSnapshot)) {
		if (value !== undefined) process.env[key as (typeof ENV_KEYS)[number]] = value;
	}
	rmSync(home, { recursive: true, force: true });
});

describe("agent reconnect", () => {
	it("emits the stable Desktop candidate contract without mutating bindings", async () => {
		const agentId = "00000000-0000-0000-0000-000000000123";
		const mock = mockFetch([
			{
				method: "GET",
				path: "/v1/agents",
				response: () =>
					jsonResponse([
						{
							id: agentId,
							name: "My Pi",
							machine_name: "Previous Laptop",
							agent_type: "pi",
						},
					]),
			},
		]);
		restoreFetch = mock.restore;

		await agentReconnect(undefined, { desktopList: true });

		expect(JSON.parse(output.join("\n"))).toEqual({
			schemaVersion: "clawdi.agentReconnectCandidates.v1",
			agents: [
				{
					id: agentId,
					type: "pi",
					displayName: "Pi",
					name: "My Pi",
					machineName: "Previous Laptop",
					isThisMachine: false,
					lastSyncAt: null,
				},
			],
		});
		expect(mock.captured.some((request) => request.method === "POST")).toBe(false);
		expect(process.exitCode).toBe(0);
	});

	it("requires explicit confirmation outside an interactive terminal", async () => {
		const agentId = "00000000-0000-0000-0000-000000000123";
		const mock = mockFetch([
			{
				method: "GET",
				path: "/v1/agents",
				response: () =>
					jsonResponse([
						{
							id: agentId,
							name: "Pi",
							machine_name: "Previous Laptop",
							agent_type: "pi",
						},
					]),
			},
		]);
		restoreFetch = mock.restore;

		await agentReconnect(agentId, { agent: "pi", daemon: false });

		expect(mock.captured.some((request) => request.method === "POST")).toBe(false);
		expect(output.some((line) => line.includes("requires explicit confirmation"))).toBe(true);
		expect(process.exitCode).toBe(1);
	});

	it("rebuilds the local binding around the current installation identity", async () => {
		const agentId = "00000000-0000-0000-0000-000000000123";
		const mock = mockFetch([
			{
				method: "GET",
				path: "/v1/agents",
				response: () =>
					jsonResponse([
						{
							id: agentId,
							name: "Pi",
							machine_name: "Previous Laptop",
							agent_type: "pi",
						},
					]),
			},
			{
				method: "POST",
				path: `/v1/agents/${agentId}/rebind`,
				response: () => jsonResponse({ id: agentId }),
			},
		]);
		restoreFetch = mock.restore;

		await agentReconnect(agentId, { agent: "pi", yes: true, daemon: false });

		const machine = JSON.parse(readFileSync(join(home, ".clawdi", "machine.json"), "utf-8")) as {
			id: string;
		};
		const registration = JSON.parse(
			readFileSync(join(home, ".clawdi", "environments", "pi.json"), "utf-8"),
		) as Record<string, unknown>;
		const listRequest = mock.captured.find((request) => request.method === "GET");
		const rebindRequest = mock.captured.find((request) => request.method === "POST");

		expect(listRequest?.path).toContain("reconnectable=true");
		expect(rebindRequest?.body).toMatchObject({
			machine_id: machine.id,
			agent_type: "pi",
			adapter_modules: ["sessions"],
		});
		expect(registration).toMatchObject({
			id: agentId,
			agentType: "pi",
			machineId: machine.id,
			userId: "cloud-user",
		});
		expect(existsSync(join(home, ".clawdi", "environments", "pi.json"))).toBe(true);
		expect(output.some((line) => line.includes("Pi reconnected"))).toBe(true);
		expect(process.exitCode).toBe(0);
	});
});

function seedOAuthAuth(): void {
	const clawdiDir = join(home, ".clawdi");
	mkdirSync(clawdiDir, { recursive: true });
	writeFileSync(
		join(clawdiDir, "auth.json"),
		`${JSON.stringify({
			authType: "clerk_oauth",
			apiKey: "oauth-access-token",
			refreshToken: "oauth-refresh-token",
			accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
			issuer: "https://clerk.test",
			clientId: "clawdi-cli",
			audience: "clawdi-api",
			tokenEndpoint: "https://clerk.test/oauth/token",
			scopes: ["openid", "offline_access"],
			subject: "clerk-user",
			userId: "cloud-user",
			endpointBinding: {
				version: 1,
				cloudApiOrigin: "https://api.test",
			},
		})}\n`,
		{ mode: 0o600 },
	);
}
