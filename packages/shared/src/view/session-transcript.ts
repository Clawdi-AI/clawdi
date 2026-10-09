import { type components, type SessionShareTarget, sessionShareScope } from "../api";
import { relativeTime } from "./utils";

type SessionShareItem = components["schemas"]["SessionShareResponse"];
type SessionShare = components["schemas"]["SessionShareListItemResponse"];

export function formatGroupHeaderTime(timestamp: string): string {
	const d = new Date(timestamp);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString(undefined, {
		year: "2-digit",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

const COMMAND_TAG_RE = /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/g;

export function parseSlashCommand(content: string): {
	name: string;
	args?: string;
	remaining: string;
} | null {
	const nameMatch = content.match(/<command-name>([\s\S]*?)<\/command-name>/);
	if (!nameMatch) return null;
	const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
	const remaining = content.replace(COMMAND_TAG_RE, "").trim();
	return {
		name: nameMatch[1].trim(),
		args: argsMatch?.[1].trim() || undefined,
		remaining,
	};
}

// Claude Code's slash command expansion arrives as a user message whose body
// is the skill's SKILL.md content — typically starts with "Base directory for this skill:".
export function isSkillExpansion(content: string): boolean {
	return /^Base directory for this skill:/i.test(content.trimStart());
}

export function formatToolPayload(value: string): string {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return value;
	}
}

export function sessionDateLabel(timestamp: string): string {
	const d = new Date(timestamp);
	const today = new Date();
	const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const dayDiff = Math.floor((startOfDay(today) - startOfDay(d)) / 86_400_000);
	let label: string;
	if (dayDiff === 0) label = "Today";
	else if (dayDiff === 1) label = "Yesterday";
	else
		label = d.toLocaleDateString(undefined, {
			weekday: "long",
			month: "short",
			day: "numeric",
			year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
		});
	return label;
}

export function shareLabel(share: Pick<SessionShareItem, "scope" | "message_count">): string {
	if (share.scope === "session") return "Full session snapshot";
	if (share.scope === "response") return "Single response snapshot";
	return `Conversation through message ${share.message_count}`;
}

export function shareDetail(share: Pick<SessionShareItem, "created_at" | "message_count">): string {
	return `Created ${relativeTime(share.created_at)} · ${share.message_count} message${share.message_count === 1 ? "" : "s"}`;
}

export function sessionShareDialogCopy(target: SessionShareTarget) {
	const title =
		target.scope === "response"
			? "Share this response"
			: target.scope === "through"
				? "Share conversation to here"
				: "Share session";
	const description =
		target.scope === "response"
			? "Anyone with the link can view this agent response."
			: target.scope === "through"
				? "Anyone with the link can view the conversation through this message."
				: "Anyone with the link can view this conversation. Future messages won’t be added.";
	return { title, description };
}

export function shareScopeLabel(share: SessionShare): string {
	const scope = sessionShareScope(share);
	if (scope === "response") return "Single agent response";
	if (scope === "through") return "Conversation excerpt";
	return "Full session snapshot";
}

export const sessionTimelineFilters = [
	{ category: "user", label: "You" },
	{ category: "assistant", label: "Agent" },
	{ category: "tools", label: "Tools" },
] as const;
export function sessionEmptyDescription(view: string) {
	return view === "tools"
		? "No tool activity in this session."
		: view === "user"
			? "No user messages in this session."
			: view === "assistant"
				? "No agent messages in this session."
				: "No visible activity in this session.";
}
export function publicSessionScopeLabel(scope: string) {
	return scope === "response"
		? "Shared response"
		: scope === "through"
			? "Shared conversation excerpt"
			: "Shared conversation";
}
export function sessionHasLaterActivity(start: string, last: string) {
	return Math.abs(new Date(last).getTime() - new Date(start).getTime()) > 5 * 60_000;
}
export const sessionDetailCopy = {
	back: "Back to Sessions",
	searchMinimum: "2+ chars",
	searching: "Searching",
	unavailable: "Unavailable",
	timelineLabel: "Show in timeline",
	share: "Share",
	export: "Export Markdown",
	search: "Search messages",
	searchPlaceholder: "Search messages…",
	previous: "Previous match",
	next: "Next match",
	clear: "Clear search",
	beginning: "Jump to beginning",
	latest: "Jump to latest",
	match: "Jump to match",
	skill: "Skill setup text",
	tool: "Tool",
	done: "Done",
	called: "Called",
	error: "Error",
	arguments: "Arguments",
	output: "Output",
	result: "Result",
	shareResponse: "Share response",
	shareThrough: "Share conversation to here",
	shareMessage: "Share message",
	sharedTitle: "Shared Session Links",
	sharedDescription: "Review and turn off every active session link from one place.",
	noLinks: "No active session links",
	noLinksDescription: "Links you create from a session will appear here.",
	browse: "Browse sessions",
	open: "Open",
	more: "More options",
	create: "Create link",
	createSnapshot: "Create new snapshot",
	revoke: "Turn off link",
	revokeTitle: "Turn off this share link?",
	revokeDescription:
		"Anyone using this link will immediately lose access. The original session stays unchanged.",
	live: "Live",
	snapshot: "Snapshot",
	liveDescription: "Updates when the session is uploaded again.",
	sharedError: "Couldn't load shared links",
	linksError: "Couldn't load share links",
	activityError: "Couldn't load activity",
	failed: "Couldn't complete this action",
	emptyShare: "This share has no readable content.",
	brand: "Clawdi",
	footer: "Shared via Clawdi",
	openShare: "Open shared Session",
	link: "Session share URL",
	inputHelp: "Enter a Clawdi Session share link or share ID.",
	exportJson: "Export JSON",
	older: "Other active links",
	olderLink: "Older link",
	notFound: "Session not found",
	notFoundDescription: "This session doesn't exist.",
	conversation: "Conversation",
	uploadDescription: "Messages appear here after the agent uploads this session.",
	uploadHelp:
		"Conversation not uploaded yet. To back-fill history from that machine, run: clawdi push --modules sessions --all-agents --all",
	gatePrivate: "Private session",
	gateSignIn: "Sign in to view",
	signIn: "Sign in",
	gatePrivateBody: "This Clawdi session is private. Sign in to check whether you have access.",
	gateForbidden: "No access",
	gateForbiddenTitle: "You don't have access to this session",
	gateForbiddenBody:
		"You don't have access to this session. Ask the owner to share the link or invite you.",
	gateExpired: "Link turned off",
	gateExpiredTitle: "This session share is no longer available",
	gateExpiredBody:
		"The owner revoked this link. Ask them to create a new share if you still need access.",
	goHome: "Go to Clawdi",
	retry: "Retry",
	refresh: "Refresh",
	delete: "Delete",
	deleteTitle: "Permanently delete this cloud session?",
	deleteDescription:
		"This permanently deletes the cloud Session, its history, and all sharing access.\n\nLocal agent files remain untouched, but this Session will never sync again.\n\nExtracted account-level Memories remain, with this Session's provenance removed.",
	deleteConfirm: "Permanently delete",
} as const;

export function sessionPullRequestUrl(pr: string): string | undefined {
	const match = pr.match(/^([^/]+)\/([^#]+)#(\d+)$/);
	if (!match) return undefined;
	const [, owner, repo, number] = match;
	return `https://github.com/${owner}/${repo}/pull/${number}`;
}
export function sessionRepositoryUrl(repo: string): string {
	return `https://github.com/${repo}`;
}
