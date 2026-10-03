import type {
	SessionMessage,
	SessionTimelineItem,
	SessionToolCall,
	SessionToolResult,
} from "./schemas";

export type TimelineMessage = SessionMessage | Extract<SessionTimelineItem, { kind: "message" }>;
export type TimelineEntry = SessionMessage | SessionTimelineItem;

function dayKey(timestamp: string | null | undefined): string | null {
	if (!timestamp) return null;
	const d = new Date(timestamp);
	if (Number.isNaN(d.getTime())) return null;
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isToolEntry(entry: TimelineEntry): entry is SessionToolCall | SessionToolResult {
	return "kind" in entry && (entry.kind === "tool_call" || entry.kind === "tool_result");
}

interface PairedToolActivity {
	call?: SessionToolCall;
	result?: SessionToolResult;
	firstItem: SessionToolCall | SessionToolResult;
	firstIndex: number;
}

// Parallel tool use is commonly serialized as call A, call B, result A,
// result B. Pair a contiguous tool run by its stable call ID while preserving
// the first-seen order and every row when a broken producer reuses an ID.
function collectToolActivities(items: TimelineEntry[], startIndex: number) {
	const activities: PairedToolActivity[] = [];
	const activitiesByCallId = new Map<string, PairedToolActivity[]>();
	let nextIndex = startIndex;
	while (nextIndex < items.length) {
		const item = items[nextIndex];
		if (!isToolEntry(item)) break;

		const matching = activitiesByCallId.get(item.call_id) ?? [];
		let activity = matching.find((candidate) =>
			item.kind === "tool_call" ? candidate.call === undefined : candidate.result === undefined,
		);
		if (!activity) {
			activity = {
				firstItem: item,
				firstIndex: nextIndex,
			};
			matching.push(activity);
			activitiesByCallId.set(item.call_id, matching);
			activities.push(activity);
		}
		if (item.kind === "tool_call") activity.call = item;
		else activity.result = item;
		nextIndex++;
	}
	return { activities, nextIndex };
}

interface TimelineRowBase {
	rowKey: string | number;
	dividerTimestamp?: string;
}

interface MessageTimelineRow extends TimelineRowBase {
	kind: "message";
	message: TimelineMessage;
	isGroupStart: boolean;
}

interface ToolTimelineRow extends TimelineRowBase {
	kind: "tool";
	call?: SessionToolCall;
	result?: SessionToolResult;
	firstTimestamp?: string | null;
}

export type SessionTimelineRow = MessageTimelineRow | ToolTimelineRow;

/**
 * Normalizes source events into the visual rows shared by the static public
 * transcript and the virtualized dashboard timeline. Tool pairs and date
 * dividers must be resolved before virtualization so both renderers preserve
 * identical grouping semantics.
 */
export function buildSessionTimelineRows(
	items: TimelineEntry[],
	itemKeys?: string[] | null,
): SessionTimelineRow[] {
	const GROUP_GAP_MS = 5 * 60_000;
	const rows: SessionTimelineRow[] = [];
	let previousDayKey: string | null = null;
	let previousMessage: TimelineMessage | null = null;
	const takeDividerTimestamp = (timestamp: string | null | undefined) => {
		const nextDayKey = dayKey(timestamp);
		if (!timestamp || !nextDayKey || nextDayKey === previousDayKey) return undefined;
		previousDayKey = nextDayKey;
		return timestamp;
	};

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (isToolEntry(item)) {
			const { activities, nextIndex } = collectToolActivities(items, i);
			for (const activity of activities) {
				rows.push({
					kind: "tool",
					rowKey:
						itemKeys?.[activity.firstIndex] ??
						`${activity.firstItem.kind}:${activity.firstItem.position}`,
					dividerTimestamp: takeDividerTimestamp(activity.firstItem.timestamp),
					call: activity.call,
					result: activity.result,
					firstTimestamp: activity.firstItem.timestamp,
				});
			}
			i = nextIndex - 1;
			previousMessage = null;
			continue;
		}

		const dividerTimestamp = takeDividerTimestamp(item.timestamp);
		const sameSpeaker =
			previousMessage?.role === item.role &&
			(item.role !== "assistant" || (previousMessage.model ?? null) === (item.model ?? null));
		const closeInTime =
			previousMessage?.timestamp && item.timestamp
				? Math.abs(
						new Date(item.timestamp).getTime() - new Date(previousMessage.timestamp).getTime(),
					) < GROUP_GAP_MS
				: false;
		rows.push({
			kind: "message",
			rowKey: itemKeys?.[i] ?? i,
			dividerTimestamp,
			message: item,
			isGroupStart: !sameSpeaker || !closeInTime || dividerTimestamp !== undefined,
		});
		previousMessage = item;
	}
	return rows;
}
