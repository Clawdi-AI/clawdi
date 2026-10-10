"use client";

import { buildSessionTimelineRows, type SessionTimelineRow } from "@clawdi/shared/api";
import { messageListClasses } from "@clawdi/shared/ui";

export { buildSessionTimelineRows, type SessionTimelineRow } from "@clawdi/shared/api";

import {
	agentTypeLabel,
	formatAbsoluteTooltip,
	formatCount,
	formatGroupHeaderTime,
	formatToolPayload,
	isSkillExpansion,
	parseSlashCommand,
	sessionDateLabel,
} from "@clawdi/shared/view";
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
import { cn } from "@/lib/utils";

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

function DateDivider({ timestamp }: { timestamp: string }) {
	const label = sessionDateLabel(timestamp);
	return (
		<div className={messageListClasses.dateDivider}>
			<div className={messageListClasses.hairline} />
			<span title={formatAbsoluteTooltip(timestamp)}>{label}</span>
			<div className={messageListClasses.hairline} />
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
				messageListClasses.messageRow,
				deferOffscreenRendering && OFFSCREEN_RENDERING_CLASS,
				isHighlighted && messageListClasses.highlighted,
			)}
		>
			{/* Avatar column. Group-start: avatar (user image / agent icon).
			    Continuation: faint HH:MM that reveals on row hover. */}
			<div className={messageListClasses.avatarColumn}>
				{isGroupStart ? (
					isUser ? (
						userAvatar ? (
							<img src={userAvatar} alt="" width={32} height={32} className="rounded-full" />
						) : (
							<div className={messageListClasses.userAvatar}>{userName[0]}</div>
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
						className={messageListClasses.continuationTime}
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
			<div className={messageListClasses.content}>
				{isGroupStart ? (
					// `flex-wrap` is what keeps long header rows
					// (`username · Opus 4.7 · 5/13/26, 15:30`) inside a
					// narrow viewport. Without it, a 320px screen forces
					// the whole page into horizontal scroll. The timestamp
					// keeps `whitespace-nowrap` so it doesn't split
					// mid-string when it wraps to its own line.
					<div className={messageListClasses.messageHeader}>
						<span className={messageListClasses.author}>{isUser ? userName : agentName}</span>
						{isUser ? null : <ModelBadge modelId={message.model} />}
						{message.timestamp ? (
							<span
								className={messageListClasses.timestamp}
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
				<div className={cn(messageListClasses.body, isUser && messageListClasses.userBubble)}>
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
		<div role="toolbar" aria-label="Message actions" className={messageListClasses.actions}>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							variant="ghost"
							size="icon-xs"
							className={messageListClasses.actionButton}
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
								className={messageListClasses.actionButton}
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
								className={messageListClasses.actionButton}
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
			<div className={messageListClasses.stack}>
				<SlashCommandPill name={cmd.name} args={cmd.args} />
				{cmd.remaining && <Markdown content={cmd.remaining} highlightQuery={highlightQuery} />}
			</div>
		);
	}
	if (isSkillExpansion(content)) {
		return (
			<CollapsibleBlock
				label="Skill setup text"
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
		<div className={messageListClasses.command}>
			<Terminal className={messageListClasses.commandIcon} />
			<span className={messageListClasses.commandName}>{name}</span>
			{args && <span className={messageListClasses.commandArgs}>{args}</span>}
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
		<div className={messageListClasses.skill}>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => setOpen((v) => !v)}
				className={messageListClasses.skillTrigger}
			>
				<ChevronRight className={cn("size-3.5 transition-transform", visible && "rotate-90")} />
				<span>{label}</span>
				{!visible && (
					<span className={messageListClasses.muted}>
						({formatCount(content.length, "char", "chars", content.length.toLocaleString())})
					</span>
				)}
			</Button>
			{visible && (
				<div className={messageListClasses.skillBody}>
					<Markdown content={content} highlightQuery={highlightQuery} />
				</div>
			)}
		</div>
	);
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
		<Tabs defaultValue={first.key} className={messageListClasses.tabs}>
			{payloads.length > 1 ? (
				<TabsList variant="line" className={messageListClasses.tabList}>
					{payloads.map((payload) => (
						<TabsTrigger key={payload.key} value={payload.key} className={messageListClasses.tab}>
							{payload.label}
						</TabsTrigger>
					))}
				</TabsList>
			) : (
				<div className={messageListClasses.payloadLabel}>{first.label}</div>
			)}
			{payloads.map((payload) => (
				<TabsContent key={payload.key} value={payload.key}>
					<pre className={messageListClasses.payload}>{formatToolPayload(payload.value)}</pre>
				</TabsContent>
			))}
		</Tabs>
	);
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
		<div
			className={cn(
				messageListClasses.toolRow,
				deferOffscreenRendering && OFFSCREEN_RENDERING_CLASS,
			)}
		>
			<div className={messageListClasses.toolIconColumn}>
				<Wrench className={messageListClasses.toolIcon} />
			</div>
			<div className={messageListClasses.content}>
				<button
					type="button"
					disabled={!hasDetails}
					onClick={() => setOpen((value) => !value)}
					aria-expanded={hasDetails ? open : undefined}
					className={messageListClasses.toolTrigger}
				>
					<code className={messageListClasses.toolName}>{name}</code>
					{isError ? (
						<span className={messageListClasses.toolError}>
							<CircleX className={messageListClasses.toolIcon} /> Error
						</span>
					) : result ? (
						<span className={messageListClasses.toolStatus}>
							<CheckCircle2 className={messageListClasses.toolIcon} /> Done
						</span>
					) : (
						<span className="shrink-0">Called</span>
					)}
					{timestamp ? (
						<span className={messageListClasses.toolTime} title={formatAbsoluteTooltip(timestamp)}>
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
					<div className={messageListClasses.toolDetails}>
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
				<div
					className={
						row.isGroupStart && !row.dividerTimestamp ? messageListClasses.groupStart : undefined
					}
				>
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
