import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ChannelActivityItem, ChannelHealthItem } from "@/hosted/v2/channels/channel-types";
import {
	channelActivityErrorSummary,
	channelHealthErrorSummary,
} from "@/hosted/v2/channels/channel-user-facing-errors";

const activity = (overrides: Partial<ChannelActivityItem> = {}): ChannelActivityItem => ({
	kind: "message",
	id: "11111111-1111-4111-8111-111111111111",
	account_id: "22222222-2222-4222-8222-222222222222",
	provider: "telegram",
	created_at: "2026-08-02T12:00:00Z",
	updated_at: "2026-08-02T12:00:00Z",
	...overrides,
});

const health = (overrides: Partial<ChannelHealthItem> = {}): ChannelHealthItem => ({
	account_id: "22222222-2222-4222-8222-222222222222",
	provider: "telegram",
	name: "Support bot",
	visibility: "private",
	channel_status: "active",
	health_status: "error",
	reasons: ["recent_error"],
	pending_inbox: 0,
	pending_deliveries: 0,
	in_progress_deliveries: 0,
	failed_deliveries: 0,
	...overrides,
});

describe("channel user-facing error summaries", () => {
	test("never returns raw activity diagnostics", () => {
		const raw = "Authorization: Bot secret-token; postgres://internal-db/tenant";
		expect(channelActivityErrorSummary(activity({ delivery_last_error: raw }))).toBe(
			"Message delivery failed. Check the channel connection and try again.",
		);
		expect(
			channelActivityErrorSummary(
				activity({ kind: "debug_event", error: raw, stage: "agent_webhook" }),
			),
		).toBe("A channel action failed. Check the channel connection and try again.");
		expect(channelActivityErrorSummary(activity())).toBeNull();
	});

	test("distinguishes a retrying delivery without exposing its diagnostic", () => {
		expect(
			channelActivityErrorSummary(
				activity({ delivery_status: "pending", delivery_last_error: "provider host 10.0.0.8" }),
			),
		).toBe("Message delivery is delayed. Clawdi will retry while the channel remains connected.");
	});

	test("never returns raw health diagnostics", () => {
		const raw = "Discord response body contained private provider diagnostics";
		expect(
			channelHealthErrorSummary(
				health({ last_error: raw, last_error_stage: "delivery", failed_deliveries: 1 }),
			),
		).toBe("Message delivery failed. Check the channel connection and try again.");
		expect(channelHealthErrorSummary(health({ last_error: raw }))).toBe(
			"A channel action failed. Check the channel connection and try again.",
		);
		expect(channelHealthErrorSummary(health())).toBeNull();
	});

	test("the detail page cannot render the raw fields directly", () => {
		const source = readFileSync(new URL("./channel-detail-page.tsx", import.meta.url), "utf8");
		expect(source).toContain("channelActivityErrorSummary(item)");
		expect(source).toContain("channelHealthErrorSummary(h)");
		expect(source).not.toContain("item.delivery_last_error ?? item.error");
		expect(source).not.toContain(">{h.last_error}<");
		expect(source).not.toContain("h.last_error_outcome");
	});
});
