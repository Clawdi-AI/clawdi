import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChannelHealthItem } from "./channel-types";
import { HealthBadge } from "./channel-ui";

const warningHealth: ChannelHealthItem = {
	account_id: "00000000-0000-0000-0000-000000000001",
	provider: "discord",
	name: "Community Discord",
	visibility: "private",
	channel_status: "active",
	health_status: "warning",
	reasons: ["pending_deliveries", "pending_inbox"],
	pending_inbox: 1,
	pending_deliveries: 2,
	in_progress_deliveries: 0,
	failed_deliveries: 0,
};

describe("HealthBadge", () => {
	test("renders a specific visible label and complete accessible detail", () => {
		const markup = renderToStaticMarkup(createElement(HealthBadge, { health: warningHealth }));

		expect(markup).toContain(">2 pending deliveries<");
		expect(markup).toContain(
			'aria-label="2 pending deliveries. Additional activity: 1 inbound message pending."',
		);
		expect(markup).toContain('title="Additional activity: 1 inbound message pending."');
		expect(markup).not.toContain(">Warning<");
	});
});
