import { describe, expect, test } from "bun:test";
import type { RuntimeUiCredentials } from "@clawdi/shared/api";
import { hermesUiCredentials, openClawUiUrl } from "@/hosted/agents/runtime-ui-credentials";

describe("runtime UI credential targeting", () => {
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
	});
});
