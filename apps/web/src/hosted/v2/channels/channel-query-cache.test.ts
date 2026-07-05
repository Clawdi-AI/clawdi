import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { channelKeys, removeDeletedChannelQueries } from "@/hosted/v2/channels/channel-query-cache";

describe("removeDeletedChannelQueries", () => {
	test("removes deleted channel detail caches and invalidates related summaries", async () => {
		const qc = new QueryClient();
		const channelId = "channel_123";

		qc.setQueryData(channelKeys.list, [{ id: channelId }]);
		qc.setQueryData(channelKeys.pool, [{ id: "bot_1" }]);
		qc.setQueryData(channelKeys.health, [{ account_id: channelId }]);
		qc.setQueryData(channelKeys.channel(channelId), { id: channelId });
		qc.setQueryData(["channel", channelId, "commands"], [{ id: "command_1" }]);
		qc.setQueryData(channelKeys.agentLinks(channelId), [{ id: "link_1" }]);
		qc.setQueryData(channelKeys.bindings(channelId), [{ id: "binding_1" }]);
		qc.setQueryData(channelKeys.activity(channelId), [{ id: "activity_1" }]);
		qc.setQueryData(channelKeys.whatsappCreds(channelId), [{ id: "credential_1" }]);
		qc.setQueryData(channelKeys.channel("channel_other"), { id: "channel_other" });
		qc.setQueryData(["agent-channel-links", "agent_1"], [{ account_id: channelId }]);

		await removeDeletedChannelQueries(qc, channelId);

		expect(qc.getQueryData(channelKeys.channel(channelId))).toBeUndefined();
		expect(qc.getQueryData(["channel", channelId, "commands"])).toBeUndefined();
		expect(qc.getQueryData(channelKeys.agentLinks(channelId))).toBeUndefined();
		expect(qc.getQueryData(channelKeys.bindings(channelId))).toBeUndefined();
		expect(qc.getQueryData(channelKeys.activity(channelId))).toBeUndefined();
		expect(qc.getQueryData(channelKeys.whatsappCreds(channelId))).toBeUndefined();
		expect(qc.getQueryData<{ id: string }>(channelKeys.channel("channel_other"))).toEqual({
			id: "channel_other",
		});
		expect(qc.getQueryState(channelKeys.list)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(channelKeys.pool)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(channelKeys.health)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(["agent-channel-links", "agent_1"])?.isInvalidated).toBe(true);
	});
});
