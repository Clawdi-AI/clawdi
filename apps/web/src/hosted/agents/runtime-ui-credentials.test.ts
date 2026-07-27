import { describe, expect, test } from "bun:test";
import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import {
	openClawdiRuntimeWindow,
	openSecureRuntimeWindow,
	resolveRuntimeUiCredentials,
} from "@/hosted/agents/runtime-ui-credentials";

describe("runtime UI credential targeting", () => {
	test("opens top-level runtime UIs without an opener", () => {
		const calls: unknown[][] = [];
		const popup = {
			close() {},
			location: { replace() {} },
			opener: { unsafe: true },
			sessionStorage: { setItem() {} },
		};
		const opened = openSecureRuntimeWindow((...args) => {
			calls.push(args);
			return popup;
		});
		expect(calls).toEqual([["about:blank", "_blank"]]);
		expect(opened?.opener).toBeNull();
	});

	test("keeps the opener only for a same-origin Clawdi runtime shell", () => {
		const popup = {
			close() {},
			location: { replace() {} },
			opener: { clawdi: true },
			sessionStorage: { setItem() {} },
		};
		const opened = openClawdiRuntimeWindow(() => popup);

		expect(opened?.opener).toEqual({ clawdi: true });
	});

	test("keeps Hermes credentials separate from its secret-free URL", () => {
		const credentials: RuntimeUiCredentials = {
			runtime: "hermes",
			auth_mode: "password",
			url: "https://runtime.example/hermes",
			username: "admin",
			password: "deployment-password",
		};
		expect(resolveRuntimeUiCredentials(credentials, "https://runtime.example/hermes")).toEqual({
			runtime: "hermes",
			value: {
				url: "https://runtime.example/hermes",
				username: "admin",
				password: "deployment-password",
			},
		});
		expect(credentials.url).not.toContain(credentials.password ?? "");
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
		expect(resolveRuntimeUiCredentials(hermes, "https://runtime.example/hermes")).toBeNull();
		expect(resolveRuntimeUiCredentials(openclaw, "https://runtime.example/openclaw/")).toBeNull();
	});

	test("preserves the exact official OpenClaw token fragment URL", () => {
		const credentials: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_device",
			url: "https://runtime.example/openclaw/#token=deployment-token",
		};
		expect(resolveRuntimeUiCredentials(credentials, "https://runtime.example/openclaw/")).toEqual({
			runtime: "openclaw",
			value: {
				url: credentials.url,
				token: "deployment-token",
			},
		});
	});

	test("rejects an OpenClaw credential URL without a token", () => {
		const credentials: RuntimeUiCredentials = {
			runtime: "openclaw",
			auth_mode: "openclaw_device",
			url: "https://runtime.example/openclaw/",
		};
		expect(resolveRuntimeUiCredentials(credentials, credentials.url)).toBeNull();
	});
});
