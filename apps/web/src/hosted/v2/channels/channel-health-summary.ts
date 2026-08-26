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
			return { label: failed, detail: "Open Health for details." };
		}
		if (health.reasons?.includes("channel_disabled")) {
			return {
				label: "Channel disabled",
				detail: "This channel is disabled. Open Health for details.",
			};
		}
		if (health.reasons?.includes("recent_error")) {
			return {
				label: "Recent error",
				detail: "A recent channel action failed. Open Health for details.",
			};
		}
		if (health.reasons?.includes("native_transport_unavailable")) {
			return {
				label: "Channel unavailable",
				detail: "This channel is currently unavailable. Open Health for details.",
			};
		}
		if (health.reasons?.includes("runtime_observation_error")) {
			return {
				label: "Channel unavailable",
				detail: "The Agent reported a problem with this channel. Open Health for details.",
			};
		}
		return {
			label: "Channel error",
			detail: "Clawdi reported an error for this channel. Open Health for details.",
		};
	}

	if (health.reasons?.includes("native_transport_reconnecting")) {
		return {
			label: "Reconnecting",
			detail: "This channel is reconnecting. Messages may be delayed.",
		};
	}
	if (health.reasons?.includes("agent_not_linked")) {
		return {
			label: "Not linked",
			detail: "This channel is not linked to an Agent.",
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
	if (health.reasons?.includes("runtime_observation_missing")) {
		return {
			label: "Setting up",
			detail: "The channel is waiting for the Agent to finish setup.",
		};
	}
	if (health.reasons?.includes("runtime_observation_stale")) {
		return {
			label: "Agent offline",
			detail: "The linked Agent is not currently online.",
		};
	}
	if (health.reasons?.includes("runtime_not_converged")) {
		return {
			label: "Setting up",
			detail: "The Agent is still applying this channel's settings.",
		};
	}
	if (health.reasons?.includes("runtime_observation_unknown")) {
		return {
			label: "Status unavailable",
			detail: "Clawdi couldn't verify this channel's status.",
		};
	}

	return {
		label: "Needs attention",
		detail: "Clawdi detected an issue with this channel. Open Health for details.",
	};
}
