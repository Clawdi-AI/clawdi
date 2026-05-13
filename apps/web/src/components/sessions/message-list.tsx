"use client";

import { ChevronRight, Terminal } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { Markdown } from "@/components/markdown";
import { ModelBadge } from "@/components/meta/model-badge";
import { Button } from "@/components/ui/button";
import type { SessionMessage } from "@/lib/api-schemas";
import { cn, formatAbsoluteTooltip } from "@/lib/utils";

/**
 * Message-thread rendering primitives, shared between the owner-dashboard
 * `/sessions/[id]` page and the public share `/s/[id]` page.
 *
 * Marked `"use client"` for two reasons:
 *   1. `CollapsibleBlock` uses `useState` for its open/closed state.
 *   2. The `Markdown` body component is itself a client component.
 *
 * Both consumer pages render `<MessageBlock>` inside their own scaffolding —
 * dashboard wraps it with an infinite-query loader + direction toggle; the
 * share page just iterates the first page server-side. The grouping logic
 * (date dividers + author/time merging) is also identical between the
 * two, so it lives here as `renderGroupedMessages`.
 */

/**
 * Group-start header timestamp: short date + 24h time. Mirrors
 * Discord's `M/D/YY, HH:MM` style (e.g. `4/24/26, 20:21`). Locale-aware.
 */
function formatGroupHeaderTime(timestamp: string): string {
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

function dayKey(timestamp: string | null | undefined): string | null {
	if (!timestamp) return null;
	const d = new Date(timestamp);
	if (Number.isNaN(d.getTime())) return null;
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function DateDivider({ timestamp }: { timestamp: string }) {
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
	return (
		<div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
			<div className="h-px flex-1 bg-border" />
			<span title={formatAbsoluteTooltip(timestamp)}>{label}</span>
			<div className="h-px flex-1 bg-border" />
		</div>
	);
}

function MessageBlock({
	message,
	userAvatar,
	userName,
	agentType,
	isGroupStart,
}: {
	message: SessionMessage;
	userAvatar?: string;
	userName: string;
	agentType: string | null | undefined;
	/**
	 * True when this message is the first in a "thread" (different author
	 * from previous, or > 5min gap). Slack / Discord / iMessage convention:
	 * only the group-start row renders avatar + author + timestamp;
	 * continuation rows render just the body. Cuts visual repetition when
	 * one agent fires 6 tool-uses in the same minute.
	 */
	isGroupStart: boolean;
}) {
	const isUser = message.role === "user";
	const agentName = agentTypeLabel(agentType);

	return (
		// `group` lives on the whole row so the continuation-row hover
		// timestamp reveals from a hover anywhere on the message.
		<div className={cn("group flex gap-3", isGroupStart ? "pt-4" : "")}>
			{/* Avatar column. Group-start: avatar (user image / agent icon).
			    Continuation: faint HH:MM that reveals on row hover. */}
			<div className="w-8 shrink-0 pt-0.5">
				{isGroupStart ? (
					isUser ? (
						userAvatar ? (
							<Image src={userAvatar} alt="" width={32} height={32} className="rounded-full" />
						) : (
							<div className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
								{userName[0]}
							</div>
						)
					) : (
						<AgentIcon agent={agentType} size="lg" shape="circle" />
					)
				) : message.timestamp ? (
					// Hover-reveal on pointer devices; always-on for touch
					// (`hover: none`) — `group-hover` never fires from a tap,
					// so without this fallback mobile users lose the
					// timestamp entirely on grouped continuation rows.
					<div
						className="hidden h-5 w-8 items-center justify-end pr-1 text-[10px] tabular-nums text-muted-foreground/60 group-hover:flex [@media(hover:none)]:flex"
						title={formatAbsoluteTooltip(message.timestamp)}
					>
						{new Date(message.timestamp).toLocaleTimeString([], {
							hour: "2-digit",
							minute: "2-digit",
						})}
					</div>
				) : null}
			</div>

			{/* Content */}
			<div className="min-w-0 flex-1">
				{isGroupStart ? (
					// `flex-wrap` is what keeps long header rows
					// (`username · Opus 4.7 · 5/13/26, 15:30`) inside a
					// narrow viewport. Without it, a 320px screen forces
					// the whole page into horizontal scroll. The timestamp
					// keeps `whitespace-nowrap` so it doesn't split
					// mid-string when it wraps to its own line.
					<div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
						<span className="text-sm font-medium">{isUser ? userName : agentName}</span>
						{isUser ? null : <ModelBadge modelId={message.model} />}
						{message.timestamp ? (
							<span
								className="whitespace-nowrap text-xs text-muted-foreground"
								title={formatAbsoluteTooltip(message.timestamp)}
							>
								{formatGroupHeaderTime(message.timestamp)}
							</span>
						) : null}
					</div>
				) : null}

				{/* `wrap-anywhere` (overflow-wrap: anywhere) lets long unbroken runs
				    — typically inline `<code>` like `clawdi.memory_search({...})` —
				    wrap inside the flex column instead of pushing the page wider
				    than the viewport. Affects min-content sizing too, so the
				    enclosing flex chain shrinks correctly on narrow screens. */}
				<div className="text-sm wrap-anywhere">
					{isUser ? (
						<UserMessageBody content={message.content} />
					) : (
						<Markdown content={message.content} />
					)}
				</div>
			</div>
		</div>
	);
}

// Matches Claude Code's slash command envelope:
//   <command-message>name</command-message>
//   <command-name>/name</command-name>
//   <command-args>…</command-args>
const COMMAND_TAG_RE = /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/g;

function parseSlashCommand(content: string): {
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
function isSkillExpansion(content: string): boolean {
	return /^Base directory for this skill:/i.test(content.trimStart());
}

function UserMessageBody({ content }: { content: string }) {
	const cmd = parseSlashCommand(content);
	if (cmd) {
		return (
			<div className="space-y-2">
				<SlashCommandPill name={cmd.name} args={cmd.args} />
				{cmd.remaining && <Markdown content={cmd.remaining} />}
			</div>
		);
	}
	if (isSkillExpansion(content)) {
		return <CollapsibleBlock label="Skill context" content={content} />;
	}
	return <Markdown content={content} />;
}

function SlashCommandPill({ name, args }: { name: string; args?: string }) {
	return (
		<div className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 font-mono text-xs">
			<Terminal className="size-3 shrink-0 text-primary" />
			<span className="font-medium text-primary">{name}</span>
			{args && <span className="break-all text-muted-foreground">{args}</span>}
		</div>
	);
}

function CollapsibleBlock({ label, content }: { label: string; content: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="rounded-md border border-dashed border-border/70 bg-muted/20">
			<Button
				variant="ghost"
				size="sm"
				onClick={() => setOpen((v) => !v)}
				className="h-auto w-full justify-start rounded-md px-2.5 py-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
			>
				<ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
				<span>{label}</span>
				{!open && (
					<span className="text-xs text-muted-foreground">
						({content.length.toLocaleString()} chars)
					</span>
				)}
			</Button>
			{open && (
				<div className="border-t border-border/50 px-3 py-2">
					<Markdown content={content} />
				</div>
			)}
		</div>
	);
}

/**
 * Renders an ordered message list with date dividers and group-start
 * grouping. The 5-minute GAP_MS threshold matches Slack / Discord —
 * same-author messages within 5 minutes collapse into a single visual
 * thread.
 *
 * `messageKeys` is an optional caller-provided per-row stable key
 * (e.g. the message's canonical position when the caller is paginating).
 * Falls back to the array index, which is fine for SSR / single-page
 * renders where order is stable.
 *
 * Exported as a Component (not a plain function) so server components
 * can render it as `<MessageList .../>` — React 19 rejects calls to
 * client-module functions from the server tree, but client components
 * rendered as JSX cross the boundary fine.
 */
export function MessageList({
	messages,
	messageKeys,
	agentType,
	userAvatar,
	userName,
}: {
	messages: SessionMessage[];
	messageKeys?: string[] | null;
	agentType: string | null | undefined;
	userAvatar?: string;
	userName: string;
}) {
	const GROUP_GAP_MS = 5 * 60_000;
	const out: React.ReactNode[] = [];
	let prevDayKey: string | null = null;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const dKey = dayKey(msg.timestamp);
		if (dKey && dKey !== prevDayKey) {
			out.push(<DateDivider key={`d-${dKey}`} timestamp={msg.timestamp ?? ""} />);
			prevDayKey = dKey;
		}
		const prev = i > 0 ? messages[i - 1] : null;
		const sameAuthor = prev?.role === msg.role;
		const closeInTime =
			prev?.timestamp && msg.timestamp
				? Math.abs(new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime()) <
					GROUP_GAP_MS
				: false;
		// A new day always starts a fresh group — even same-author messages
		// across the divider shouldn't merge.
		const dividerJustEmitted = i > 0 && dKey != null && dayKey(prev?.timestamp) !== dKey;
		const isGroupStart = !sameAuthor || !closeInTime || dividerJustEmitted;
		out.push(
			<MessageBlock
				key={messageKeys?.[i] ?? i}
				message={msg}
				userAvatar={userAvatar}
				userName={userName}
				agentType={agentType}
				isGroupStart={isGroupStart}
			/>,
		);
	}
	return <>{out}</>;
}
