import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostHog } from "posthog-node";
import { ApiError } from "./api-client";
import { setAuth } from "./config";
import { cliFailureClass, commandEvent, reportCommandEvent } from "./posthog";

const previousOptIn = process.env.CLAWDI_ANALYTICS;
const previousDnt = process.env.DO_NOT_TRACK;
const originalEnv = {
	POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
	CLAWDI_HOME: process.env.CLAWDI_HOME,
	CLAWDI_AUTH_TOKEN: process.env.CLAWDI_AUTH_TOKEN,
};
const roots: string[] = [];
afterEach(() => {
	if (previousOptIn === undefined) delete process.env.CLAWDI_ANALYTICS;
	else process.env.CLAWDI_ANALYTICS = previousOptIn;
	if (previousDnt === undefined) delete process.env.DO_NOT_TRACK;
	else process.env.DO_NOT_TRACK = previousDnt;
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	mock.restore();
});

describe("CLI PostHog producer", () => {
	test("official SDK receives only the shared subject and content-free outcome", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-analytics-"));
		roots.push(root);
		process.env.CLAWDI_HOME = root;
		process.env.CLAWDI_ANALYTICS = "true";
		process.env.POSTHOG_API_KEY = "test-project-key";
		delete process.env.CLAWDI_AUTH_TOKEN;
		delete process.env.DO_NOT_TRACK;
		setAuth({
			authType: "clerk_oauth",
			apiKey: "PRIVATE TOKEN",
			refreshToken: "PRIVATE REFRESH",
			accessTokenExpiresAt: new Date().toISOString(),
			issuer: "https://clerk.test",
			clientId: "fixture",
			audience: "fixture",
			tokenEndpoint: "https://clerk.test/token",
			scopes: [],
			subject: "user_opaque",
			userId: "opaque-local",
		});
		const capture = spyOn(PostHog.prototype, "captureImmediate").mockImplementation(async () => {});
		expect(await reportCommandEvent(commandEvent("push", 10))).toBe(true);
		const payload = capture.mock.calls[0]?.[0];
		expect(payload).toMatchObject({
			distinctId: "user_opaque",
			event: "cli_command_completed",
			disableGeoip: true,
			properties: {
				command_group: "push",
				duration_ms: 10,
				failure_class: null,
				source: "cli",
				schema_version: 1,
			},
		});
		expect(JSON.stringify(payload)).not.toContain("PRIVATE");
		setAuth({ apiKey: "PRIVATE LEGACY TOKEN", userId: "opaque-local" });
		expect(await reportCommandEvent(commandEvent("push", 10))).toBe(false);
		expect(capture).toHaveBeenCalledTimes(1);
	});
	test("events contain only bounded command group and failure class", () => {
		const result = commandEvent(
			"vault set PRIVATE_TOKEN /private/path",
			12.4,
			new ApiError({ status: 401, body: "private@example.test", hint: "Private error" }),
		);
		expect(result).toEqual({
			name: "cli_command_failed",
			properties: { command_group: "vault", duration_ms: 12, failure_class: "auth" },
		});
		expect(JSON.stringify(result)).not.toContain("private");
		expect(commandEvent("private-command", Number.NaN)).toEqual({
			name: "cli_command_completed",
			properties: { command_group: "other", duration_ms: 0, failure_class: null },
		});
	});
	test("network, server, forbidden and throttling have separate classes", () => {
		for (const [status, expected] of [
			[0, "network"],
			[403, "forbidden"],
			[429, "rate_limit"],
			[503, "server"],
			[422, "validation"],
		] as const) {
			expect(
				cliFailureClass(new ApiError({ status, body: "private", hint: "Private error" })),
			).toBe(expected);
		}
	});
	test("opt-out and DNT avoid all telemetry and credential reads", async () => {
		delete process.env.CLAWDI_ANALYTICS;
		expect(await reportCommandEvent(commandEvent("push", 10))).toBe(false);
		process.env.CLAWDI_ANALYTICS = "true";
		process.env.DO_NOT_TRACK = "1";
		expect(await reportCommandEvent(commandEvent("push", 10))).toBe(false);
	});
});
