import { describe, expect, test } from "bun:test";
import type {
	DeployComponents,
	DeploymentEventStreamSnapshotHandoff,
	DeploymentRead,
} from "./deploy";
import {
	isDeploymentEventStreamSnapshotHandoff,
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
	payment_mode: "card",
	x402_enabled: true,
	auto_reload_enabled: true,
	auto_reload_threshold_usd: "5",
	auto_reload_amount_cents: 2500,
	auto_reload_monthly_cap_cents: 10_000,
};

const usage: DeploySchemas["V2HostedUsageSummaryResponse"] = {
	period_start: "2026-07-01",
	period_end: "2026-07-31",
	total_usd: "0.000001",
	total_requests: 1,
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

describe("USD-native v2 billing contract", () => {
	test("keeps exact USD strings while Stripe inputs remain cents", () => {
		expect(wallet).toMatchObject({
			balance_usd: "25.000001",
			auto_reload_threshold_usd: "5",
			auto_reload_amount_cents: 2500,
		});
		expect(usage.total_usd).toBe("0.000001");
		expect(usage.by_model[0]?.amount_usd).toBe("0.000001");
	});
});
