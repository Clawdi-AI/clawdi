import { describe, expect, test } from "bun:test";
import {
	AGENT_CHANNEL_LINKS_REFETCH_INTERVAL_MS,
	agentChannelLinksQueryBehavior,
} from "./channel-query-options.logic";

describe("Agent channel links query behavior", () => {
	test("polls only for an enabled active surface and never in the background", () => {
		expect(agentChannelLinksQueryBehavior("agent-1", { poll: true })).toEqual({
			enabled: true,
			refetchInterval: AGENT_CHANNEL_LINKS_REFETCH_INTERVAL_MS,
			refetchIntervalInBackground: false,
		});
		expect(agentChannelLinksQueryBehavior("agent-1")).toEqual({
			enabled: true,
			refetchInterval: false,
			refetchIntervalInBackground: false,
		});
		expect(agentChannelLinksQueryBehavior("", { poll: true })).toEqual({
			enabled: false,
			refetchInterval: false,
			refetchIntervalInBackground: false,
		});
		expect(agentChannelLinksQueryBehavior("agent-1", { enabled: false, poll: true })).toEqual({
			enabled: false,
			refetchInterval: false,
			refetchIntervalInBackground: false,
		});
	});
});
