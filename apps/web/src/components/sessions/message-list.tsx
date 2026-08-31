"use client";

import {
	CheckCircle2,
	ChevronRight,
	CircleX,
	Copy,
	ListEnd,
	Share2,
	Terminal,
	Wrench,
} from "lucide-react";
import { useState } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { Markdown } from "@/components/markdown";
import { ModelBadge } from "@/components/meta/model-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type {
	SessionMessage,
	SessionTimelineItem,
	SessionToolCall,
	SessionToolResult,
} from "@/lib/api-schemas";
import { splitSearchHighlight } from "@/lib/search-highlight";
import { cn, formatAbsoluteTooltip } from "@/lib/utils";

const OFFSCREEN_RENDERING_CLASS = "[content-visibility:auto] [contain-intrinsic-size:auto_160px]";
type TimelineMessage = SessionMessage | Extract<SessionTimelineItem, { kind: "message" }>;
type TimelineEntry = SessionMessage | SessionTimelineItem;

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
	isHighlighted,
	highlightQuery,
	deferOffscreenRendering,
	onShareMessage,
}: {
	message: TimelineMessage;
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
	isHighlighted?: boolean;
	highlightQuery?: string;
	deferOffscreenRendering: boolean;
	onShareMessage?: (target: { scope: "through" | "response"; position: number }) => void;
}) {
	const isUser = message.role === "user";
	const agentName = agentTypeLabel(agentType);
	const position = "position" in message ? message.position : null;

	return (
		// `group` lives on the whole row so the continuation-row hover
		// timestamp reveals from a hover anywhere on the message.
		<div
			data-search-match={isHighlighted ? "true" : undefined}
			aria-current={isHighlighted ? "location" : undefined}
			className={cn(
				"group flex scroll-mt-24 gap-3 rounded-md border-l-2 border-transparent p-2",
				deferOffscreenRendering && OFFSCREEN_RENDERING_CLASS,
				isHighlighted && "border-primary bg-primary/5",
			)}
		>
			{/* Avatar column. Group-start: avatar (user image / agent icon).
			    Continuation: faint HH:MM that reveals on row hover. */}
			<div className="w-8 shrink-0 pt-0.5">
				{isGroupStart ? (
					isUser ? (
						userAvatar ? (
							<img src={userAvatar} alt="" width={32} height={32} className="rounded-full" />
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
						className="hidden h-5 w-8 items-center justify-end pr-1 text-3xs tabular-nums text-muted-foreground/60 group-hover:flex [@media(hover:none)]:flex"
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
				    enclosing flex chain shrinks correctly on narrow screens.

				    User turns get a quiet tinted bubble: in a long agent
				    transcript the #1 scan job is "where did I say something" —
				    name + avatar alone disappear between walls of markdown. */}
				<div
					className={cn(
						"text-sm wrap-anywhere",
						isUser && "w-fit max-w-full rounded-lg bg-accent/60 px-3 py-2",
					)}
				>
					{isUser ? (
						<UserMessageBody
							content={message.content}
							highlightQuery={highlightQuery}
							revealCollapsedMatch={isHighlighted}
						/>
					) : (
						<Markdown content={message.content} highlightQuery={highlightQuery} />
					)}
				</div>
				<MessageActions
					content={message.content}
					position={position}
					isAssistant={!isUser}
					onShareMessage={onShareMessage}
				/>
			</div>
		</div>
	);
}

function MessageActions({
	content,
	position,
	isAssistant,
	onShareMessage,
}: {
	content: string;
	position: number | null;
	isAssistant: boolean;
	onShareMessage?: (target: { scope: "through" | "response"; position: number }) => void;
}) {
	const { copied, copy } = useCopyToClipboard({ success: false });
	return (
		<div
			role="toolbar"
			aria-label="Message actions"
			className="pointer-events-none mt-0.5 flex min-h-6 w-fit items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
		>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="ghost"
							size="icon-xs"
							className="text-muted-foreground pointer-coarse:size-11"
							onClick={() => copy(content)}
							aria-label="Copy message"
						/>
					}
				>
					{copied ? <CheckCircle2 /> : <Copy />}
				</TooltipTrigger>
				<TooltipContent>Copy message</TooltipContent>
			</Tooltip>
			{isAssistant && position !== null && onShareMessage ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-xs"
								className="text-muted-foreground pointer-coarse:size-11"
								onClick={() => onShareMessage({ scope: "response", position })}
								aria-label="Share response"
							/>
						}
					>
						<Share2 />
					</TooltipTrigger>
					<TooltipContent>Share response</TooltipContent>
				</Tooltip>
			) : null}
			{position !== null && onShareMessage ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon-xs"
								className="text-muted-foreground pointer-coarse:size-11"
								onClick={() => onShareMessage({ scope: "through", position })}
								aria-label="Share conversation to here"
							/>
						}
					>
						<ListEnd />
					</TooltipTrigger>
					<TooltipContent>Share conversation to here</TooltipContent>
				</Tooltip>
			) : null}
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

function UserMessageBody({
	content,
	highlightQuery,
	revealCollapsedMatch,
}: {
	content: string;
	highlightQuery?: string;
	revealCollapsedMatch?: boolean;
}) {
	const cmd = parseSlashCommand(content);
	if (cmd) {
		return (
			<div className="space-y-2">
				<SlashCommandPill name={cmd.name} args={cmd.args} />
				{cmd.remaining && <Markdown content={cmd.remaining} highlightQuery={highlightQuery} />}
			</div>
		);
	}
	if (isSkillExpansion(content)) {
		return (
			<CollapsibleBlock
				label="Skill Setup Text"
				content={content}
				highlightQuery={highlightQuery}
				revealMatch={revealCollapsedMatch}
			/>
		);
	}
	return <Markdown content={content} highlightQuery={highlightQuery} />;
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

function CollapsibleBlock({
	label,
	content,
	highlightQuery,
	revealMatch,
}: {
	label: string;
	content: string;
	highlightQuery?: string;
	revealMatch?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const containsMatch = highlightQuery
		? splitSearchHighlight(content, highlightQuery).some((part) => part.highlighted)
		: false;
	const visible = open || (revealMatch && containsMatch);
	return (
		<div className="rounded-md border border-dashed border-border/70 bg-muted/30">
			<Button
				variant="ghost"
				size="sm"
				onClick={() => setOpen((v) => !v)}
				className="h-auto w-full justify-start rounded-md px-2.5 py-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
			>
				<ChevronRight className={cn("size-3.5 transition-transform", visible && "rotate-90")} />
				<span>{label}</span>
				{!visible && (
					<span className="text-xs text-muted-foreground">
						({content.length.toLocaleString()} chars)
					</span>
				)}
			</Button>
			{visible && (
				<div className="border-t border-border/50 px-3 py-2">
					<Markdown content={content} highlightQuery={highlightQuery} />
				</div>
			)}
		</div>
	);
}

function isToolEntry(entry: TimelineEntry): entry is SessionToolCall | SessionToolResult {
	return "kind" in entry && (entry.kind === "tool_call" || entry.kind === "tool_result");
}

function formatToolPayload(value: string): string {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return value;
	}
}

function ToolDetails({ call, result }: { call?: SessionToolCall; result?: SessionToolResult }) {
	const payloads = [
		call?.arguments_json
			? { key: "arguments", label: "Arguments", value: call.arguments_json }
			: null,
		result?.content ? { key: "output", label: "Output", value: result.content } : null,
		result?.result_json ? { key: "result", label: "Result", value: result.result_json } : null,
	].filter((payload): payload is { key: string; label: string; value: string } => payload !== null);
	const first = payloads[0];
	if (!first) return null;

	return (
		<Tabs defaultValue={first.key} className="min-w-0 gap-1.5">
			{payloads.length > 1 ? (
				<TabsList variant="line" className="h-7">
					{payloads.map((payload) => (
						<TabsTrigger key={payload.key} value={payload.key} className="h-7 px-1.5 text-xs">
							{payload.label}
						</TabsTrigger>
					))}
				</TabsList>
			) : (
				<div className="text-3xs font-medium uppercase text-muted-foreground">{first.label}</div>
			)}
			{payloads.map((payload) => (
				<TabsContent key={payload.key} value={payload.key}>
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-l-2 border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
						{formatToolPayload(payload.value)}
					</pre>
				</TabsContent>
			))}
		</Tabs>
	);
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

function ToolActivity({
	call,
	result,
	firstTimestamp,
	deferOffscreenRendering,
}: {
	call?: SessionToolCall;
	result?: SessionToolResult;
	firstTimestamp?: string | null;
	deferOffscreenRendering: boolean;
}) {
	const [open, setOpen] = useState(false);
	const name = call?.name ?? result?.name ?? "Tool";
	const hasDetails = Boolean(call?.arguments_json || result?.content || result?.result_json);
	const isError = result?.status === "error";
	const timestamp = firstTimestamp ?? call?.timestamp ?? result?.timestamp;

	return (
		<div className={cn("flex gap-3 py-1.5", deferOffscreenRendering && OFFSCREEN_RENDERING_CLASS)}>
			<div className="flex w-8 shrink-0 justify-center pt-2 text-muted-foreground">
				<Wrench className="size-3.5" />
			</div>
			<div className="min-w-0 flex-1">
				<button
					type="button"
					disabled={!hasDetails}
					onClick={() => setOpen((value) => !value)}
					aria-expanded={hasDetails ? open : undefined}
					className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent"
				>
					<code className="truncate font-medium text-foreground">{name}</code>
					{isError ? (
						<span className="inline-flex shrink-0 items-center gap-1 text-destructive">
							<CircleX className="size-3.5" /> Error
						</span>
					) : result ? (
						<span className="inline-flex shrink-0 items-center gap-1">
							<CheckCircle2 className="size-3.5" /> Done
						</span>
					) : (
						<span className="shrink-0">Called</span>
					)}
					{timestamp ? (
						<span
							className="ml-auto shrink-0 tabular-nums"
							title={formatAbsoluteTooltip(timestamp)}
						>
							{new Date(timestamp).toLocaleTimeString([], {
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
					) : null}
					<ChevronRight
						aria-hidden="true"
						className={cn(
							"size-3.5 shrink-0 transition-transform",
							open && "rotate-90",
							!hasDetails && "invisible",
						)}
					/>
				</button>
				{open ? (
					<div className="px-2 pb-2 pt-1">
						<ToolDetails call={call} result={result} />
					</div>
				) : null}
			</div>
		</div>
	);
}

export interface SessionTimelineListProps {
	items: TimelineEntry[];
	itemKeys?: string[] | null;
	agentType: string | null | undefined;
	userAvatar?: string;
	userName: string;
	highlightedMessageKey?: string | null;
	highlightQuery?: string;
	onShareMessage?: (target: { scope: "through" | "response"; position: number }) => void;
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

export function SessionTimelineRowView({
	row,
	agentType,
	userAvatar,
	userName,
	highlightedMessageKey,
	highlightQuery,
	deferOffscreenRendering,
	onShareMessage,
}: Omit<SessionTimelineListProps, "items" | "itemKeys"> & {
	row: SessionTimelineRow;
	deferOffscreenRendering: boolean;
}) {
	const isHighlighted = row.kind === "message" && row.rowKey === highlightedMessageKey;
	return (
		<>
			{row.dividerTimestamp ? <DateDivider timestamp={row.dividerTimestamp} /> : null}
			{row.kind === "message" ? (
				<div className={row.isGroupStart && !row.dividerTimestamp ? "pt-2" : undefined}>
					<MessageBlock
						message={row.message}
						userAvatar={userAvatar}
						userName={userName}
						agentType={agentType}
						isGroupStart={row.isGroupStart}
						isHighlighted={isHighlighted}
						highlightQuery={highlightQuery}
						deferOffscreenRendering={deferOffscreenRendering}
						onShareMessage={onShareMessage}
					/>
				</div>
			) : (
				<ToolActivity
					call={row.call}
					result={row.result}
					firstTimestamp={row.firstTimestamp}
					deferOffscreenRendering={deferOffscreenRendering}
				/>
			)}
		</>
	);
}

/**
 * Static renderer used by public shares. Dashboard timelines use the same row
 * model through the virtualized renderer.
 */
export function SessionTimelineList(props: SessionTimelineListProps) {
	const rows = buildSessionTimelineRows(props.items, props.itemKeys);
	return (
		<>
			{rows.map((row) => (
				<SessionTimelineRowView
					key={row.rowKey}
					row={row}
					agentType={props.agentType}
					userAvatar={props.userAvatar}
					userName={props.userName}
					highlightedMessageKey={props.highlightedMessageKey}
					highlightQuery={props.highlightQuery}
					onShareMessage={props.onShareMessage}
					deferOffscreenRendering
				/>
			))}
		</>
	);
}
