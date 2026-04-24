import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { doctor } from "../../src/commands/doctor";
import { cleanupTmp, copyFixtureToTmp } from "../adapters/helpers";
import { jsonResponse, mockFetch, seedAuthAndEnv } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origExitCode: number | string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origExitCode = process.exitCode;
	tmpHome = copyFixtureToTmp("hermes");
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	process.exitCode = origExitCode;
	if (tmpHome) cleanupTmp(tmpHome);
});

describe("doctor --json", () => {
	it("reports auth as ✗ when not logged in, without any fetch", async () => {
		// Spy console.log to capture JSON output
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		const { captured: fetchCalls, restore } = mockFetch([]);
		try {
			await doctor({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const checks = JSON.parse(captured) as Array<{ name: string; ok: boolean; hint?: string }>;
		const auth = checks.find((c) => c.name === "Auth");
		expect(auth?.ok).toBe(false);
		expect(auth?.hint).toContain("clawdi auth login");

		// API reachability is skipped when not logged in
		const api = checks.find((c) => c.name === "API reachability");
		expect(api?.ok).toBe(false);

		// No network calls should have happened (all checks are skipped when unauthenticated)
		expect(fetchCalls).toHaveLength(0);

		// doctor sets exitCode non-zero when any check fails
		expect(process.exitCode).toBe(1);
	});

	it("reports ✓ when logged in with reachable backend + registered environment", async () => {
		seedAuthAndEnv(tmpHome, "hermes");

		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/auth/me",
				response: () => jsonResponse({ id: "u1", email: "e" }),
			},
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () => jsonResponse({ K1: "v1", K2: "v2" }),
			},
			{
				method: "GET",
				path: "/api/connectors/mcp-config",
				response: () => jsonResponse({ ok: true }),
			},
		]);
		try {
			await doctor({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const checks = JSON.parse(captured) as Array<{ name: string; ok: boolean; detail?: string }>;
		expect(checks.find((c) => c.name === "Auth")?.ok).toBe(true);
		expect(checks.find((c) => c.name === "API reachability")?.ok).toBe(true);
		expect(checks.find((c) => c.name === "Environments")?.ok).toBe(true);
		expect(checks.find((c) => c.name === "Environments")?.detail).toContain("hermes");
		expect(checks.find((c) => c.name === "Vault resolve")?.ok).toBe(true);
		expect(checks.find((c) => c.name === "MCP connectors")?.ok).toBe(true);

		// Hermes fixture present → that agent shows ✓, others show ✗ (not installed)
		const hermesCheck = checks.find((c) => c.name === "Agent: Hermes");
		expect(hermesCheck?.ok).toBe(true);
	});

	it("reports API unreachable when /api/auth/me fails", async () => {
		seedAuthAndEnv(tmpHome, "hermes");

		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/auth/me",
				response: () => new Response("nope", { status: 503 }),
			},
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () => new Response("", { status: 503 }),
			},
			{
				method: "GET",
				path: "/api/connectors/mcp-config",
				response: () => new Response("", { status: 503 }),
			},
		]);
		try {
			await doctor({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const checks = JSON.parse(captured) as Array<{ name: string; ok: boolean; hint?: string }>;
		const api = checks.find((c) => c.name === "API reachability");
		expect(api?.ok).toBe(false);
		expect(api?.hint).toContain("retry");
	});
});
