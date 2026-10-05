import type { SessionListItem } from "../api";
import { formatSessionSummary, recencyBucketFor } from "./utils";

export function groupSessionsByRecency(
	sessions: SessionListItem[],
	groupBy: "last_activity_at" | "started_at" = "last_activity_at",
) {
	const groups: Array<{ key: string; label: string; items: SessionListItem[] }> = [];
	for (const session of sessions) {
		const bucket = recencyBucketFor(
			groupBy === "started_at" ? session.started_at : session.last_activity_at,
		);
		const last = groups[groups.length - 1];
		if (last && last.key === bucket.key) last.items.push(session);
		else groups.push({ key: bucket.key, label: bucket.label, items: [session] });
	}

	return groups;
}

export function sessionTitle(
	session: Pick<SessionListItem, "summary" | "local_session_id">,
): string {
	return formatSessionSummary(session.summary) || session.local_session_id.slice(0, 8);
}

export function sessionCardModel(session: SessionListItem, quietAutomated = true) {
	const title = sessionTitle(session);
	const projectFolder = session.project_path?.split("/").pop();
	const totalTokens = session.input_tokens + session.output_tokens;
	const isAutomated = quietAutomated && /^(Cron:|\[)/.test(title);
	return { title, projectFolder, totalTokens, isAutomated };
}
