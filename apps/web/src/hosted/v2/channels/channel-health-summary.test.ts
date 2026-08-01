import { describe, expect, test } from "bun:test";
import { channelHealthSummary } from "./channel-health-summary";
import type { ChannelHealthItem } from "./channel-types";

function health(overrides: Partial<ChannelHealthItem> = {}): ChannelHealthItem {
	return {
		account_id: "00000000-0000-0000-0000-000000000001",
		provider: "discord",
		name: "Community Discord",
		visibility: "private",
		channel_status: "active",
		health_status: "ok",
		reasons: [],
		pending_inbox: 0,
		pending_deliveries: 0,
		in_progress_deliveries: 0,
		failed_deliveries: 0,
		...overrides,
	};
}

describe("channel health summaries", () => {
	test("explains warning activity from typed counters", () => {
		expect(
			channelHealthSummary(
				health({
					health_status: "warning",
					reasons: ["deliveries_in_progress", "pending_deliveries", "pending_inbox"],
					in_progress_deliveries: 2,
					pending_deliveries: 3,
					pending_inbox: 1,
				}),
			),
		).toEqual({
			label: "2 deliveries in progress",
			detail: "Additional activity: 3 pending deliveries; 1 inbound message pending.",
		});
	});

	test("uses a clear fallback for a warning without recognized activity", () => {
		expect(
			channelHealthSummary(health({ health_status: "warning", reasons: ["future_health_reason"] })),
		).toEqual({
			label: "Needs attention",
			detail:
				"Channel health reported an unrecognized warning. Open the channel Health view for details.",
		});
	});

	test("prioritizes actionable error states", () => {
		expect(
			channelHealthSummary(
				health({ health_status: "error", reasons: ["failed_deliveries"], failed_deliveries: 1 }),
			).label,
		).toBe("1 failed delivery");
		expect(
			channelHealthSummary(health({ health_status: "error", reasons: ["channel_disabled"] })).label,
		).toBe("Channel disabled");
	});
});
