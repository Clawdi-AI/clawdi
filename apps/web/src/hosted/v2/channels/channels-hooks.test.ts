import { describe, expect, mock, test } from "bun:test";
import {
	CHANNEL_HEALTH_REFETCH_INTERVAL_MS,
	channelHealthQueryOptions,
} from "@/hosted/v2/channels/channel-health-query";
import { channelKeys } from "@/hosted/v2/channels/channel-query-cache";

describe("channelHealthQueryOptions", () => {
	test("polls live channel health on a modest interval", async () => {
		const health = [{ account_id: "channel_123", status: "healthy" }];
		const queryFn = mock(async () => health);

		const options = channelHealthQueryOptions(queryFn);

		expect(options.queryKey).toEqual(channelKeys.health);
		expect(options.refetchInterval).toBe(CHANNEL_HEALTH_REFETCH_INTERVAL_MS);
		expect(options.refetchInterval).toBe(20_000);
		await expect(options.queryFn()).resolves.toEqual(health);
		expect(queryFn).toHaveBeenCalledTimes(1);
	});
});
