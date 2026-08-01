import type { ChannelHealthItem } from "@/hosted/v2/channels/channel-types";

export type ChannelHealthSummary = {
	label: string;
	detail: string;
};

function countLabel(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function warningDetails(health: ChannelHealthItem): string[] {
	const details: string[] = [];
	if (health.in_progress_deliveries > 0) {
		details.push(
			countLabel(health.in_progress_deliveries, "delivery in progress", "deliveries in progress"),
		);
	}
	if (health.pending_deliveries > 0) {
		details.push(countLabel(health.pending_deliveries, "pending delivery", "pending deliveries"));
	}
	if (health.pending_inbox > 0) {
		details.push(
			countLabel(health.pending_inbox, "inbound message pending", "inbound messages pending"),
		);
	}
	return details;
}

/**
 * Turns channel health counters into compact card copy without discarding the
 * operational reason behind a warning. The detail is suitable for both a
 * visible Health view and an accessible badge description.
 */
export function channelHealthSummary(health: ChannelHealthItem): ChannelHealthSummary {
	if (health.health_status === "ok") {
		return { label: "Healthy", detail: "No issues detected." };
	}

	if (health.health_status === "error") {
		if (health.failed_deliveries > 0) {
			const failed = countLabel(health.failed_deliveries, "failed delivery", "failed deliveries");
			return { label: failed, detail: "Open the channel Health view for error details." };
		}
		if (health.reasons?.includes("channel_disabled")) {
			return {
				label: "Channel disabled",
				detail: "This channel is disabled. Open the channel Health view for details.",
			};
		}
		if (health.reasons?.includes("recent_error")) {
			return {
				label: "Recent error",
				detail: "A recent channel operation failed. Open the channel Health view for details.",
			};
		}
		return {
			label: "Channel error",
			detail: "Channel health reported an error. Open the channel Health view for details.",
		};
	}

	const details = warningDetails(health);
	if (details.length > 0) {
		return {
			label: details[0],
			detail:
				details.length > 1
					? `Additional activity: ${details.slice(1).join("; ")}.`
					: "This channel activity is still being processed.",
		};
	}

	return {
		label: "Needs attention",
		detail:
			"Channel health reported an unrecognized warning. Open the channel Health view for details.",
	};
}
