import { describe, expect, test } from "bun:test";
import type { DeployPaths } from "./deploy";
import { isRuntimeUiCredentials, isRuntimeUiEndpointInfo } from "./deploy";

describe("runtime UI endpoint contract", () => {
	test("accepts only runtime-matched top-level native authentication URLs", () => {
		expect(
			isRuntimeUiEndpointInfo({
				runtime: "openclaw",
				role: "control_ui",
				url: "https://agent.example.test/control/",
				auth_mode: "openclaw_device",
				browser_mode: "top_level",
			}),
		).toBe(true);
		expect(
			isRuntimeUiEndpointInfo({
				runtime: "hermes",
				role: "control_ui",
				url: "https://agent.example.test/hermes",
				auth_mode: "password",
				browser_mode: "top_level",
			}),
		).toBe(true);
	});

	test.each([
		true,
		false,
	])("rejects the removed requires_bridge_token field when set to %s", (requiresBridgeToken) => {
		expect(
			isRuntimeUiEndpointInfo({
				runtime: "openclaw",
				role: "control_ui",
				url: "https://agent.example.test/control/",
				auth_mode: "openclaw_device",
				browser_mode: "top_level",
				requires_bridge_token: requiresBridgeToken,
			}),
		).toBe(false);
	});

	test.each([
		{
			name: "runtime/auth mismatch",
			value: {
				runtime: "hermes",
				role: "control_ui",
				url: "https://agent.example.test/hermes",
				auth_mode: "openclaw_device",
				browser_mode: "top_level",
			},
		},
		{
			name: "query token",
			value: {
				runtime: "openclaw",
				role: "control_ui",
				url: "https://agent.example.test/control/?token=token",
				auth_mode: "openclaw_device",
				browser_mode: "top_level",
			},
		},
		{
			name: "blank fragment token",
			value: {
				runtime: "openclaw",
				role: "control_ui",
				url: "https://agent.example.test/control/#token=%20",
				auth_mode: "openclaw_device",
				browser_mode: "top_level",
			},
		},
		{
			name: "Hermes fragment",
			value: {
				runtime: "hermes",
				role: "control_ui",
				url: "https://agent.example.test/hermes#token=unexpected",
				auth_mode: "password",
				browser_mode: "top_level",
			},
		},
		{
			name: "iframe mode",
			value: {
				runtime: "hermes",
				role: "control_ui",
				url: "https://agent.example.test/hermes",
				auth_mode: "password",
				browser_mode: "iframe",
			},
		},
	])("rejects $name", ({ value }) => {
		expect(isRuntimeUiEndpointInfo(value)).toBe(false);
	});

	test("accepts only runtime-matched secret credential responses", () => {
		expect(
			isRuntimeUiCredentials({
				runtime: "hermes",
				url: "https://agent.example.test/hermes",
				auth_mode: "password",
				username: "admin",
				password: "deployment-password",
			}),
		).toBe(true);
		expect(
			isRuntimeUiCredentials({
				runtime: "openclaw",
				url: "https://agent.example.test/control/#token=deployment-token",
				auth_mode: "openclaw_device",
			}),
		).toBe(true);
		expect(
			isRuntimeUiCredentials({
				runtime: "hermes",
				url: "https://agent.example.test/hermes?password=leak",
				auth_mode: "password",
				username: "admin",
				password: "deployment-password",
			}),
		).toBe(false);
	});

	test("does not expose the runtime UI redemption operation", () => {
		type HasRuntimeUiRedemption =
			"/v2/deployments/{deployment_id}/runtime-ui/redemption" extends keyof DeployPaths
				? true
				: false;
		const hasRuntimeUiRedemption: HasRuntimeUiRedemption = false;
		expect(hasRuntimeUiRedemption).toBe(false);
		type HasRuntimeUiCredentials =
			"/v2/deployments/{deployment_id}/runtime-ui/credentials" extends keyof DeployPaths
				? true
				: false;
		const hasRuntimeUiCredentials: HasRuntimeUiCredentials = true;
		expect(hasRuntimeUiCredentials).toBe(true);
	});
});

describe("declarative deployment contract", () => {
	test("keeps only canonical deployment mutations and operation reads", () => {
		type HasAgentSettingsRoute =
			"/v2/deployments/{deployment_id}/agents/{agent_type}" extends keyof DeployPaths
				? true
				: false;
		type HasAgentProviderRoute =
			"/v2/deployments/{deployment_id}/agents/{agent_type}/ai-provider" extends keyof DeployPaths
				? true
				: false;
		type HasOperationRead = "/v2/operations/{operation_id}" extends keyof DeployPaths
			? true
			: false;
		const hasAgentSettingsRoute: HasAgentSettingsRoute = false;
		const hasAgentProviderRoute: HasAgentProviderRoute = false;
		const hasOperationRead: HasOperationRead = true;
		expect({ hasAgentSettingsRoute, hasAgentProviderRoute, hasOperationRead }).toEqual({
			hasAgentSettingsRoute: false,
			hasAgentProviderRoute: false,
			hasOperationRead: true,
		});
	});

	test("requires concurrency headers and exposes canonical settings fields", () => {
		type Patch = DeployPaths["/v2/deployments/{deployment_id}"]["patch"];
		type Headers = Patch["parameters"]["header"];
		type Body = Patch["requestBody"]["content"]["application/json"];
		const headers: Headers = {
			"Idempotency-Key": "settings-attempt",
			"If-Match": '"resource-version"',
		};
		const body: Body = {
			language: "en",
			timezone: "Etc/UTC",
			primary_model: { provider_id: "managed", model: "gpt-5.5" },
			provider_ids: ["managed"],
			ai_provider_auth_kind: "managed",
		};
		expect(headers["If-Match"]).toBe('"resource-version"');
		expect(body.timezone).toBe("Etc/UTC");
	});

	test("models creation as an accepted operation with status-by-request headers", () => {
		type Create = DeployPaths["/v2/deployments"]["post"];
		type Headers = Create["parameters"]["header"];
		type Accepted = Create["responses"][202]["content"]["application/json"];
		type AcceptedHeaders = Create["responses"][202]["headers"];
		const headers: Headers = { "Idempotency-Key": "deploy-attempt" };
		const acceptedHeaders: AcceptedHeaders = {
			"Content-Location": "/v2/deployments/by-request/deploy-request-1",
		};
		const accepted: Accepted = {
			name: "operations/op-create",
			metadata: {
				"@type": "type.googleapis.com/clawdi.v2.DeploymentOperationMetadata",
				deploymentId: "hdep_created",
				verb: "create",
				targetGeneration: 1,
				manifestETag: '"manifest-1"',
				createTime: "2026-07-22T00:00:00Z",
				updateTime: "2026-07-22T00:00:00Z",
			},
			done: false,
		};
		expect(headers["Idempotency-Key"]).toBe("deploy-attempt");
		expect(acceptedHeaders["Content-Location"]).toContain("deploy-request-1");
		expect(accepted.metadata.verb).toBe("create");
	});
});
