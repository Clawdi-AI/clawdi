import { describe, expect, test } from "bun:test";
import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import {
	openClawRuntimeUiWindowTarget,
	openSecureRuntimeWindow,
	resolveRuntimeUiCredentials,
	runtimeUiLaunchTarget,
} from "@/hosted/agents/runtime-ui-credentials";

describe("runtime UI credential targeting", () => {
	test("opens the selected runtime target synchronously without an opener", () => {
		const calls: unknown[][] = [];
		const target = "https://runtime.example/openclaw/#token=deployment-token";
		const popup = {
			close() {},
			location: {
				replace(url: string | URL) {
					calls.push(["replace", url]);
				},
			},
			opener: { unsafe: true },
		};
		const opened = openSecureRuntimeWindow((...args) => {
			calls.push(args);
			return popup;
		}, target);
		expect(calls).toEqual([
			["about:blank", "_blank"],
			["replace", target],
		]);
		expect(opened?.opener).toBeNull();
	});

	test("closes the placeholder when target navigation cannot start", () => {
		let closed = false;
		const popup = {
			close() {
				closed = true;
			},
			location: {
				replace() {
					throw new Error("navigation denied");
				},
			},
			opener: { unsafe: true },
		};

		expect(openSecureRuntimeWindow(() => popup, "https://runtime.example/openclaw/")).toBeNull();
		expect(closed).toBeTrue();
	});

	test("closes the placeholder when the browser refuses opener isolation", () => {
		let closed = false;
		const popup = {
			close() {
				closed = true;
			},
			location: { replace() {} },
			get opener() {
				return null;
			},
			set opener(_value: unknown) {
				throw new Error("opener isolation denied");
			},
		};

		expect(openSecureRuntimeWindow(() => popup, "https://runtime.example/openclaw/")).toBeNull();
		expect(closed).toBeTrue();
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
		expect(runtimeUiLaunchTarget(credentials)).toBe(credentials.url);
		const rootCredentials = { ...credentials, url: "https://runtime.example/" };
		expect(runtimeUiLaunchTarget(rootCredentials)).toBe("https://runtime.example/chat");
		expect(resolveRuntimeUiCredentials(rootCredentials, rootCredentials.url, "rv-current")).toEqual(
			rootCredentials,
		);
		expect(
			resolveRuntimeUiCredentials(rootCredentials, "https://runtime.example/chat", "rv-current"),
		).toBeNull();
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

	test("enables new-window launch after the current iframe load boundary", () => {
		const native: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_token",
			url: "https://runtime.example/openclaw/",
			deployment_resource_version: "rv-current",
			token: "deployment-token",
			handoff_url:
				"https://runtime.example/openclaw/#bootstrapToken=one-time-token&bootstrapProfile=owner",
		};
		const legacy: RuntimeUiCredentials = {
			...native,
			handoff_url: "https://runtime.example/openclaw/#token=deployment-token",
		};

		expect(openClawRuntimeUiWindowTarget(native, false)).toBeNull();
		expect(openClawRuntimeUiWindowTarget(native, true)).toBe(native.url);
		expect(openClawRuntimeUiWindowTarget(legacy, false)).toBeNull();
		expect(openClawRuntimeUiWindowTarget(legacy, true)).toBe(legacy.handoff_url);
		expect(openClawRuntimeUiWindowTarget(null, false)).toBeNull();
		expect(openClawRuntimeUiWindowTarget(null, true)).toBeNull();
	});
});
