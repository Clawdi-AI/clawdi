import { describe, expect, test } from "bun:test";
import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import {
	hermesCredentialsForGeneration,
	hermesUiCredentials,
	openClawUiCredentials,
	openClawUiUrl,
	openSecureRuntimeWindow,
} from "@/hosted/agents/runtime-ui-credentials";

describe("runtime UI credential targeting", () => {
	test("opens top-level runtime UIs without an opener", () => {
		const calls: unknown[][] = [];
		const popup = {
			close() {},
			location: { replace() {} },
			opener: { unsafe: true },
		};
		const opened = openSecureRuntimeWindow((...args) => {
			calls.push(args);
			return popup;
		});
		expect(calls).toEqual([["about:blank", "_blank"]]);
		expect(opened?.opener).toBeNull();
	});

	test("keeps Hermes credentials separate from its secret-free URL", () => {
		const credentials: RuntimeUiCredentials = {
			runtime: "hermes",
			auth_mode: "password",
			url: "https://runtime.example/hermes",
			username: "admin",
			password: "deployment-password",
		};
		expect(hermesUiCredentials(credentials, "https://runtime.example/hermes")).toEqual({
			url: "https://runtime.example/hermes",
			username: "admin",
			password: "deployment-password",
		});
		expect(credentials.url).not.toContain(credentials.password ?? "");
	});

	test("does not reuse Hermes credentials after deployment generation advances", () => {
		const credentials = {
			url: "https://runtime.example/hermes",
			username: "admin",
			password: "generation-one-password",
		};
		expect(hermesCredentialsForGeneration(credentials, 1, 1)).toBe(credentials);
		expect(hermesCredentialsForGeneration(credentials, 1, 2)).toBeNull();
	});

	test("rejects credentials targeting a different published endpoint", () => {
		const hermes: RuntimeUiCredentials = {
			runtime: "hermes",
			auth_mode: "password",
			url: "https://other.example/hermes",
			username: "admin",
			password: "deployment-password",
		};
		const openclaw: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_device",
			url: "https://other.example/openclaw/#token=deployment-token",
		};
		expect(hermesUiCredentials(hermes, "https://runtime.example/hermes")).toBeNull();
		expect(openClawUiUrl(openclaw, "https://runtime.example/openclaw/")).toBeNull();
	});

	test("preserves the exact official OpenClaw token fragment URL", () => {
		const credentials: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_device",
			url: "https://runtime.example/openclaw/#token=deployment-token",
		};
		expect(openClawUiUrl(credentials, "https://runtime.example/openclaw/")).toBe(credentials.url);
		expect(openClawUiCredentials(credentials, "https://runtime.example/openclaw/")).toEqual({
			url: credentials.url,
			token: "deployment-token",
		});
	});

	test("rejects an OpenClaw credential URL without a token", () => {
		const credentials: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_device",
			url: "https://runtime.example/openclaw/",
		};
		expect(openClawUiCredentials(credentials, credentials.url)).toBeNull();
	});
});
