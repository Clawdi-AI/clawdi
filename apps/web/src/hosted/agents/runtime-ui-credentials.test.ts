import { describe, expect, test } from "bun:test";
import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import {
	loadRuntimeUiLaunchCredentials,
	openSecureRuntimeWindow,
	resolveRuntimeUiCredentials,
	runtimeUiLaunchTarget,
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
			deployment_resource_version: "rv-current",
			username: "admin",
			password: "deployment-password",
		};
		expect(
			resolveRuntimeUiCredentials(credentials, "https://runtime.example/hermes", "rv-current"),
		).toEqual(credentials);
		expect(credentials.url).not.toContain(credentials.password ?? "");
		expect(runtimeUiLaunchTarget(credentials)).toBe(credentials.url);
	});

	test("rejects credentials targeting a different published endpoint", () => {
		const hermes: RuntimeUiCredentials = {
			runtime: "hermes",
			auth_mode: "password",
			url: "https://other.example/hermes",
			deployment_resource_version: "rv-current",
			username: "admin",
			password: "deployment-password",
		};
		const openclaw: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_token",
			url: "https://other.example/openclaw/",
			deployment_resource_version: "rv-current",
			token: "deployment-token",
			handoff_url:
				"https://other.example/openclaw/#bootstrapToken=one-time-token&bootstrapProfile=owner",
		};
		expect(
			resolveRuntimeUiCredentials(hermes, "https://runtime.example/hermes", "rv-current"),
		).toBeNull();
		expect(
			resolveRuntimeUiCredentials(openclaw, "https://runtime.example/openclaw/", "rv-current"),
		).toBeNull();
	});

	test("preserves the exact official OpenClaw browser handoff URL", () => {
		const credentials: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_token",
			url: "https://runtime.example/openclaw/",
			deployment_resource_version: "rv-current",
			token: "deployment-token",
			handoff_url:
				"https://runtime.example/openclaw/#bootstrapToken=one-time-token&bootstrapProfile=owner",
		};
		expect(
			resolveRuntimeUiCredentials(credentials, "https://runtime.example/openclaw/", "rv-current"),
		).toEqual(credentials);
		expect(runtimeUiLaunchTarget(credentials)).toBe(credentials.handoff_url);
		expect(runtimeUiLaunchTarget(credentials)).not.toBe(credentials.url);
	});

	test("opens the exact legacy fallback and rejects a stale rollout", () => {
		const credentials: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_token",
			url: "https://runtime.example/openclaw/",
			deployment_resource_version: "rv-current",
			token: "deployment-token",
			handoff_url: "https://runtime.example/openclaw/#token=deployment-token",
		};
		expect(resolveRuntimeUiCredentials(credentials, credentials.url, "rv-current")).toEqual(
			credentials,
		);
		expect(runtimeUiLaunchTarget(credentials)).toBe(credentials.handoff_url);
		expect(
			resolveRuntimeUiCredentials(
				{
					...credentials,
					handoff_url: `${credentials.url}#bootstrapToken=one-time-token&bootstrapProfile=owner`,
				},
				credentials.url,
				"rv-new",
			),
		).toBeNull();
	});

	test("requests a fresh single-use handoff for every OpenClaw window", async () => {
		const embedded: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_token",
			url: "https://runtime.example/openclaw/",
			deployment_resource_version: "rv-current",
			token: "deployment-token",
			handoff_url:
				"https://runtime.example/openclaw/#bootstrapToken=embedded-token&bootstrapProfile=owner",
		};
		const fresh: RuntimeUiCredentials = {
			...embedded,
			handoff_url:
				"https://runtime.example/openclaw/#bootstrapToken=fresh-token&bootstrapProfile=owner",
		};
		let requests = 0;

		const resolved = await loadRuntimeUiLaunchCredentials("openclaw", embedded, async () => {
			requests += 1;
			return fresh;
		});

		expect(requests).toBe(1);
		expect(resolved).toBe(fresh);
	});

	test("reuses non-single-use Hermes credentials", async () => {
		const current: RuntimeUiCredentials = {
			runtime: "hermes",
			auth_mode: "password",
			url: "https://runtime.example/hermes",
			deployment_resource_version: "rv-current",
			username: "admin",
			password: "deployment-password",
		};

		const resolved = await loadRuntimeUiLaunchCredentials("hermes", current, async () => {
			throw new Error("Hermes credentials should not be requested again");
		});

		expect(resolved).toBe(current);
	});
});
