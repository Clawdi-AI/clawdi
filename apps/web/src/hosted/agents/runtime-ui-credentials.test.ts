import { describe, expect, test } from "bun:test";
import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import {
	forgetOpenClawNativeReady,
	hasOpenClawNativeReady,
	openClawRuntimeUiWindowTarget,
	openSecureRuntimeWindow,
	rememberOpenClawNativeReady,
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

		expect(openClawRuntimeUiWindowTarget(native, native.url, false, false)).toBeNull();
		expect(openClawRuntimeUiWindowTarget(native, native.url, false, true)).toBe(native.url);
		expect(openClawRuntimeUiWindowTarget(legacy, legacy.url, false, false)).toBeNull();
		expect(openClawRuntimeUiWindowTarget(legacy, legacy.url, false, true)).toBe(legacy.handoff_url);
		expect(openClawRuntimeUiWindowTarget(null, native.url, true, false)).toBeNull();
		expect(openClawRuntimeUiWindowTarget(null, native.url, true, true)).toBe(native.url);
	});

	test("persists only completed native bootstrap for the deployment endpoint", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		};
		const endpointUrl = "https://one.runtime.example/";
		const native: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_token",
			url: endpointUrl,
			deployment_resource_version: "rv-current",
			token: "deployment-token",
			handoff_url: `${endpointUrl}#bootstrapToken=one-time-token&bootstrapProfile=owner`,
		};
		const legacy: RuntimeUiCredentials = {
			...native,
			handoff_url: `${endpointUrl}#token=deployment-token`,
		};
		values.set("clawdi.openclaw-bootstrap-attempted.hdep_one", endpointUrl);

		expect(hasOpenClawNativeReady(storage, "hdep_one", endpointUrl)).toBeFalse();
		expect(values.has("clawdi.openclaw-bootstrap-attempted.hdep_one")).toBeFalse();
		expect(rememberOpenClawNativeReady(storage, "hdep_one", endpointUrl, legacy)).toBeFalse();
		expect(hasOpenClawNativeReady(storage, "hdep_one", endpointUrl)).toBeFalse();
		expect(rememberOpenClawNativeReady(storage, "hdep_one", endpointUrl, native)).toBeTrue();
		expect(hasOpenClawNativeReady(storage, "hdep_one", endpointUrl)).toBeTrue();
		expect(
			hasOpenClawNativeReady(storage, "hdep_one", "https://moved.runtime.example/"),
		).toBeFalse();
		expect(hasOpenClawNativeReady(storage, "hdep_two", endpointUrl)).toBeFalse();
		forgetOpenClawNativeReady(storage, "hdep_one");
		expect(hasOpenClawNativeReady(storage, "hdep_one", endpointUrl)).toBeFalse();
	});
});
