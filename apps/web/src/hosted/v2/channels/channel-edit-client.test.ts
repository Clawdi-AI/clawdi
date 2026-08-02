import { describe, expect, test } from "bun:test";
import { normalizeAgentChannelLinks } from "./channel-edit-client.logic";

const account = {
	id: "11111111-1111-4111-8111-111111111111",
	provider: "telegram",
	name: "Telegram bot",
	status: "active",
	visibility: "private" as const,
	has_provider_token: true,
	webhook_url: "https://example.test/telegram",
	created_at: "2026-08-01T00:00:00Z",
};

function link(bindingCount?: number) {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		account_id: account.id,
		agent_id: "33333333-3333-4333-8333-333333333333",
		status: "active",
		created_at: "2026-08-01T00:00:00Z",
		account,
		...(bindingCount === undefined ? {} : { binding_count: bindingCount }),
	};
}

describe("agent channel link response normalization", () => {
	test("defaults a missing binding count during an independent backend rollout", () => {
		expect(normalizeAgentChannelLinks([link()])[0]?.binding_count).toBe(0);
	});

	test("preserves the backend aggregate when present", () => {
		expect(normalizeAgentChannelLinks([link(3)])[0]?.binding_count).toBe(3);
	});
});
