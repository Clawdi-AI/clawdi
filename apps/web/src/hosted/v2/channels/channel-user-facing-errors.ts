import type { ChannelActivityItem, ChannelHealthItem } from "@/hosted/v2/channels/channel-types";

const DELIVERY_DELAYED_SUMMARY =
	"Message delivery is delayed. Clawdi will keep trying while the channel is connected.";
const DELIVERY_FAILED_SUMMARY =
	"Message delivery failed. Check the channel connection and try again.";
const CHANNEL_EVENT_FAILED_SUMMARY =
	"A channel action failed. Check the channel connection and try again.";

/**
 * Channel activity error fields contain raw provider/runtime diagnostics. Keep
 * those values out of the product surface and derive copy only from stable,
 * non-sensitive lifecycle fields.
 */
export function channelActivityErrorSummary(item: ChannelActivityItem): string | null {
	if (item.delivery_last_error) {
		return item.delivery_status?.toLowerCase() === "pending"
			? DELIVERY_DELAYED_SUMMARY
			: DELIVERY_FAILED_SUMMARY;
	}
	return item.error ? CHANNEL_EVENT_FAILED_SUMMARY : null;
}

/** The health endpoint reuses the same raw diagnostic fields as activity. */
export function channelHealthErrorSummary(health: ChannelHealthItem): string | null {
	if (!health.last_error) return null;
	return health.last_error_stage?.toLowerCase() === "delivery" || health.failed_deliveries > 0
		? DELIVERY_FAILED_SUMMARY
		: CHANNEL_EVENT_FAILED_SUMMARY;
}
