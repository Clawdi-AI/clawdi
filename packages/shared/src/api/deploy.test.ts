import { describe, expect, test } from "bun:test";
import type {
	DeployComponents,
	DeploymentEventStreamSnapshotHandoff,
	DeploymentRead,
} from "./deploy";
import {
	isDeploymentEventStreamSnapshotHandoff,
	isRuntimeUiCredentials,
	isRuntimeUiEndpointInfo,
	unwrapDeploymentEventStreamSnapshotHandoff,
	unwrapDeploymentList,
} from "./deploy";

const deployments: DeploymentRead[] = [];
const handoff: DeploymentEventStreamSnapshotHandoff = {
	snapshot_isolation: "REPEATABLE READ",
	read_only: true,
	deployments: [],
	operations: [],
	event_stream_cursor: "cursor_test",
};
type DeploySchemas = DeployComponents["schemas"];

const wallet: DeploySchemas["V2WalletResponse"] = {
	balance_usd: "25.000001",
	x402_enabled: true,
	x402_payment_authority: null,
	x402_payment_status: "idle",
	auto_reload_enabled: true,
	auto_reload_has_payment_method: true,
	auto_reload_currency: "usd",
	auto_reload_required_consent_version: "wallet_auto_reload_off_session_v2",
	auto_reload_amount_policy: "wallet_reload_configured_plus_negative_balance_v1",
	auto_reload_threshold_usd: "5",
	auto_reload_amount_cents: 2500,
	auto_reload_monthly_cap_cents: 10_000,
	auto_reload_monthly_spent_cents: 2_500,
	auto_reload_period_end: "2026-09-01T00:00:00Z",
	auto_reload_status: "active",
};

const usage: DeploySchemas["V2HostedUsageSummaryResponse"] = {
	period_start: "2026-07-01",
	period_end: "2026-07-31",
	availability: "complete",
	unavailable_sections: [],
	breakdown_limit: 100,
	truncated_sections: [],
	total_usd: "0.000001",
	total_requests: 1,
	by_agent: [
		{
			agent_id: "hdep_test",
			agent_name: "Test agent",
			amount_usd: "0.000001",
			requests: 1,
		},
	],
	by_model: [
		{
			model: "gpt-test",
			provider: "managed",
			amount_usd: "0.000001",
			requests: 1,
		},
	],
	by_day: [{ date: "2026-07-24", amount_usd: "0.000001" }],
};

describe("deployment list response split", () => {
	test("keeps the default list response as a deployment array", () => {
		expect(unwrapDeploymentList(deployments)).toBe(deployments);
		expect(() => unwrapDeploymentList(handoff)).toThrow(
			"Unexpected event-stream handoff response for deployment list request",
		);
	});

	test("accepts only the event-stream snapshot handoff shape", () => {
		expect(isDeploymentEventStreamSnapshotHandoff(handoff)).toBe(true);
		expect(unwrapDeploymentEventStreamSnapshotHandoff(handoff)).toBe(handoff);
		expect(() => unwrapDeploymentEventStreamSnapshotHandoff(deployments)).toThrow(
			"Unexpected deployment list response for event-stream handoff request",
		);
		expect(
			isDeploymentEventStreamSnapshotHandoff({
				...handoff,
				read_only: false,
			}),
		).toBe(false);
	});
});

describe("Runtime UI access contracts", () => {
	test("accepts embedded endpoints and the official OpenClaw browser handoff", () => {
		expect(
			isRuntimeUiEndpointInfo({
				runtime: "openclaw",
				role: "control_ui",
				url: "https://runtime.example/openclaw/",
				auth_mode: "openclaw_token",
				browser_mode: "embedded_and_top_level",
			}),
		).toBe(true);
		expect(
			isRuntimeUiCredentials({
				runtime: "openclaw",
				auth_mode: "openclaw_token",
				url: "https://runtime.example/openclaw/",
				deployment_resource_version: "rv-current",
				token: "gateway-token",
				handoff_url:
					"https://runtime.example/openclaw/#bootstrapToken=one-time-token&bootstrapProfile=owner",
			}),
		).toBe(true);
	});

	test.each(["", "/", "/openclaw", "/openclaw/", "/nested/openclaw/"])(
		"accepts a public gateway URL for endpoint path %s",
		(path) => {
			const url = `https://runtime.example${path}`;
			const fragment = new URLSearchParams({
				bootstrapToken: "one-time+token/&=",
				bootstrapProfile: "owner",
				gatewayUrl: `wss://runtime.example${path.replace(/\/+$/, "")}`,
			});
			expect(
				isRuntimeUiCredentials({
					runtime: "openclaw",
					auth_mode: "openclaw_token",
					url,
					deployment_resource_version: "rv-current",
					token: "gateway-token",
					handoff_url: `${url}#${fragment}`,
				}),
			).toBe(true);
		},
	);

	test.each([
		...[
			"",
			"ws://runtime.example/openclaw",
			"wss://other.example/openclaw",
			"wss://runtime.example:18789/openclaw",
			"wss://runtime.example/other",
			"wss://runtime.example/openclaw/",
			"wss://runtime.example/openclaw?redirect=evil",
			"wss://runtime.example/openclaw#evil",
			"wss://user@runtime.example/openclaw",
			"wss://runtime.example/openclaw\n",
		].map((value) => `gatewayUrl=${encodeURIComponent(value)}`),
		"unknown=value",
		"bootstrapToken=other",
		"bootstrapProfile=owner",
		"gatewayUrl=wss%3A%2F%2Fruntime.example%2Fopenclaw&gatewayUrl=wss%3A%2F%2Fruntime.example%2Fopenclaw",
	])("rejects untrusted or duplicate handoff fields: %s", (extra) => {
		expect(
			isRuntimeUiCredentials({
				runtime: "openclaw",
				auth_mode: "openclaw_token",
				url: "https://runtime.example/openclaw/",
				deployment_resource_version: "rv-current",
				token: "gateway-token",
				handoff_url: `https://runtime.example/openclaw/#bootstrapToken=token&bootstrapProfile=owner&${extra}`,
			}),
		).toBe(false);
	});

	test("validates optional bootstrap expiry without rejecting older credentials", () => {
		const credential = {
			runtime: "openclaw",
			auth_mode: "openclaw_token",
			url: "https://runtime.example/",
			deployment_resource_version: "rv-current",
			token: "gateway-token",
			handoff_url: "https://runtime.example/#bootstrapToken=one-time-token&bootstrapProfile=owner",
		};
		for (const expiry of [undefined, null, 1_900_000_000_123]) {
			expect(
				isRuntimeUiCredentials({ ...credential, browser_bootstrap_expires_at_ms: expiry }),
			).toBe(true);
		}
		for (const expiry of ["1900000000123", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				isRuntimeUiCredentials({ ...credential, browser_bootstrap_expires_at_ms: expiry }),
			).toBe(false);
		}
	});

	test("accepts the exact legacy token fallback and rejects mismatched handoffs", () => {
		const credential = {
			runtime: "openclaw",
			auth_mode: "openclaw_token",
			url: "https://runtime.example/openclaw/",
			deployment_resource_version: "rv-current",
			token: "gateway-token",
			handoff_url: "https://runtime.example/openclaw/#token=gateway-token",
		};
		expect(isRuntimeUiCredentials(credential)).toBe(true);
		expect(
			isRuntimeUiCredentials({
				...credential,
				handoff_url: "https://runtime.example/openclaw/#token=other-token",
			}),
		).toBe(false);
		expect(
			isRuntimeUiCredentials({
				...credential,
				handoff_url:
					"https://other.example/openclaw/#bootstrapToken=one-time-token&bootstrapProfile=owner",
			}),
		).toBe(false);
	});
});

describe("USD-native v2 billing contract", () => {
	test("keeps exact USD strings while Stripe inputs remain cents", () => {
		expect(wallet).toMatchObject({
			balance_usd: "25.000001",
			auto_reload_threshold_usd: "5",
			auto_reload_amount_cents: 2500,
		});
		expect(usage.total_usd).toBe("0.000001");
		expect(usage.availability).toBe("complete");
		expect(usage.by_agent?.[0]?.agent_id).toBe("hdep_test");
		expect(usage.by_model[0]?.amount_usd).toBe("0.000001");
	});
});
