import { type SessionTimelineRow, splitSearchHighlight } from "@clawdi/shared/api";
import {
	agentIconRadiusClasses,
	agentIconSizeClasses,
	messageListClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentTypeLabel,
	formatGroupHeaderTime,
	formatToolPayload,
	isSkillExpansion,
	parseSlashCommand,
	sessionDateLabel,
} from "@clawdi/shared/view";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import CheckCircle2 from "lucide-react-native/icons/circle-check";
import CircleX from "lucide-react-native/icons/circle-x";
import ListEnd from "lucide-react-native/icons/list-end";
import Share2 from "lucide-react-native/icons/share-2";
import Terminal from "lucide-react-native/icons/terminal";
import Wrench from "lucide-react-native/icons/wrench";
import { useMemo, useState } from "react";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { Markdown } from "@/components/markdown";
import { ModelBadge } from "@/components/sessions/meta";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { AppPressable, AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webBoth, webText, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { NativeSegments } from "@/platform/navigation/segmented-control";

export function SessionTimelineRowView({
	row,
	agentType,
	userName = "User",
	highlighted = false,
	query,
	disabled,
	onShareMessage,
	onShareText,
}: {
	row: SessionTimelineRow;
	agentType?: string | null;
	userName?: string;
	highlighted?: boolean;
	query?: string;
	disabled?: boolean;
	onShareMessage?: (target: { scope: "through" | "response"; position: number }) => void;
	onShareText?: (content: string) => void;
}) {
	const t = useI18n();
	const [open, setOpen] = useState(false);
	const message = row.kind === "message" ? row.message : undefined;
	const isUser = message?.role === "user";
	const timestamp = message?.timestamp;
	const command = message && isUser ? parseSlashCommand(message.content) : null;
	const skill = message && isUser && isSkillExpansion(message.content);
	const revealSkill =
		highlighted &&
		query &&
		message &&
		splitSearchHighlight(message.content, query).some((part) => part.highlighted);
	const skillVisible = open || revealSkill;
	const position =
		row.kind === "message" && "position" in row.message && typeof row.message.position === "number"
			? row.message.position
			: null;
	const isGroupStart = row.kind === "message" && row.isGroupStart;
	return (
		<>
			{row.dividerTimestamp ? (
				<WebView recipe={styles.dateDivider}>
					<WebView recipe={styles.hairline} />
					<WebText recipe={webText(styles.dateDivider)}>
						{sessionDateLabel(row.dividerTimestamp)}
					</WebText>
					<WebView recipe={styles.hairline} />
				</WebView>
			) : null}
			{message ? (
				<WebView recipe={isGroupStart && !row.dividerTimestamp ? styles.groupStart : ""}>
					<WebView
						testID={position !== null ? `session-message-${position}` : undefined}
						recipe={`${styles.messageRow} ${highlighted ? styles.highlighted : ""}`}
						accessibilityLabel={
							highlighted ? t("sessionDetailMobile.currentSearchMatch") : undefined
						}
					>
						<WebView recipe={styles.avatarColumn}>
							{isGroupStart ? (
								isUser ? (
									<WebView recipe={styles.userAvatar}>
										<WebText recipe={webText(styles.userAvatar)}>{userName[0]}</WebText>
									</WebView>
								) : (
									<AgentFrameworkIcon
										agent={agentType}
										pixelSize={32}
										boxClassName={webView(
											`${agentIconSizeClasses.lg} ${agentIconRadiusClasses.circle}`,
										)}
									/>
								)
							) : timestamp ? (
								<WebText recipe={styles.continuationTime}>
									{new Date(timestamp).toLocaleTimeString([], {
										hour: "2-digit",
										minute: "2-digit",
									})}
								</WebText>
							) : null}
						</WebView>
						<WebView recipe={styles.content}>
							{isGroupStart ? (
								<WebView recipe={styles.messageHeader}>
									<WebText recipe={styles.author}>
										{isUser ? userName : agentTypeLabel(agentType)}
									</WebText>
									{!isUser ? <ModelBadge modelId={message.model} /> : null}
									{timestamp ? (
										<WebText recipe={styles.timestamp}>{formatGroupHeaderTime(timestamp)}</WebText>
									) : null}
								</WebView>
							) : null}
							<WebView recipe={`${styles.body} ${isUser ? styles.userBubble : ""}`}>
								{command ? (
									<WebView recipe={styles.stack}>
										<WebView recipe={styles.command}>
											<Icon as={Terminal} className={webView(styles.commandIcon)} />
											<WebText recipe={styles.commandName}>{command.name}</WebText>
											{command.args ? (
												<WebText recipe={styles.commandArgs}>{command.args}</WebText>
											) : null}
										</WebView>
										{command.remaining ? (
											<Markdown content={command.remaining} highlightQuery={query} />
										) : null}
									</WebView>
								) : skill ? (
									<WebView recipe={styles.skill}>
										<Button
											variant="ghost"
											size="sm"
											className={webView(styles.skillTrigger)}
											onPress={() => setOpen((value) => !value)}
										>
											<Icon as={ChevronRight} />
											<WebText recipe={styles.skillTrigger}>
												{t("sessionDetail.skill")}
												{!skillVisible
													? t("labels.characterCount", {
															count: message.content.length.toLocaleString(),
														})
													: ""}
											</WebText>
										</Button>
										{skillVisible ? (
											<WebView recipe={styles.skillBody}>
												<Markdown content={message.content} highlightQuery={query} />
											</WebView>
										) : null}
									</WebView>
								) : (
									<Markdown content={message.content} highlightQuery={query} />
								)}
							</WebView>
							<WebView recipe={styles.actions} style={{ opacity: 1 }}>
								{onShareText ? (
									<Button
										variant="ghost"
										size="icon-xs"
										className={webView(styles.actionButton, { "pointer-coarse": true })}
										disabled={disabled}
										accessibilityLabel={t("sessionDetail.shareMessage")}
										onPress={() => onShareText(message.content)}
									>
										<Icon as={Share2} />
									</Button>
								) : null}
								{onShareMessage && position !== null ? (
									<>
										{!isUser ? (
											<Button
												variant="ghost"
												size="icon-xs"
												className={webView(styles.actionButton, { "pointer-coarse": true })}
												disabled={disabled}
												accessibilityLabel={t("sessionDetail.shareResponse")}
												onPress={() => onShareMessage({ scope: "response", position })}
											>
												<Icon as={Share2} />
											</Button>
										) : null}
										<Button
											variant="ghost"
											size="icon-xs"
											className={webView(styles.actionButton, { "pointer-coarse": true })}
											disabled={disabled}
											accessibilityLabel={t("sessionDetail.shareThrough")}
											onPress={() => onShareMessage({ scope: "through", position })}
										>
											<Icon as={ListEnd} />
										</Button>
									</>
								) : null}
							</WebView>
						</WebView>
					</WebView>
				</WebView>
			) : row.kind === "tool" ? (
				<ToolActivity row={row} />
			) : null}
		</>
	);
}

function ToolActivity({ row }: { row: Extract<SessionTimelineRow, { kind: "tool" }> }) {
	const t = useI18n();
	const [open, setOpen] = useState(false);
	const [payloadKey, setPayloadKey] = useState<string>();
	const payloads = [
		row.call?.arguments_json
			? { key: "arguments", value: row.call.arguments_json, label: t("sessionDetail.arguments") }
			: null,
		row.result?.content
			? { key: "output", value: row.result.content, label: t("sessionDetail.output") }
			: null,
		row.result?.result_json
			? { key: "result", value: row.result.result_json, label: t("sessionDetail.result") }
			: null,
	].filter((p) => p !== null);
	const first = payloads[0];
	const active = payloads.find((payload) => payload.key === payloadKey) ?? first;
	const timestamp = row.firstTimestamp ?? row.call?.timestamp ?? row.result?.timestamp;
	const isError = row.result?.status === "error";
	return (
		<WebView recipe={styles.toolRow}>
			<WebView recipe={styles.toolIconColumn}>
				<Icon as={Wrench} className={webBoth(styles.toolIcon)} />
			</WebView>
			<WebView recipe={styles.content}>
				<AppPressable
					className={webView(styles.toolTrigger)}
					accessibilityRole="button"
					accessibilityState={{ expanded: open, disabled: !first }}
					disabled={!first}
					onPress={() => setOpen((value) => !value)}
				>
					<WebText
						recipe={`${webText(styles.toolTrigger)} ${styles.toolName} font-mono`}
						numberOfLines={1}
					>
						{row.call?.name ?? row.result?.name ?? t("sessionDetail.tool")}
					</WebText>
					<WebView recipe={isError ? styles.toolError : styles.toolStatus}>
						{row.result ? (
							<Icon as={isError ? CircleX : CheckCircle2} className={webBoth(styles.toolIcon)} />
						) : null}
						<WebText
							recipe={`${webText(styles.toolTrigger)} ${webText(isError ? styles.toolError : styles.toolStatus)}`}
						>
							{t(
								isError
									? "sessionDetail.error"
									: row.result
										? "sessionDetail.done"
										: "sessionDetail.called",
							)}
						</WebText>
					</WebView>
					{timestamp ? (
						<WebText recipe={`${webText(styles.toolTrigger)} ${styles.toolTime}`}>
							{new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
						</WebText>
					) : null}
					{first ? <Icon as={ChevronRight} /> : null}
				</AppPressable>
				{open && active ? (
					<WebView recipe={styles.toolDetails}>
						<WebView recipe={styles.tabs}>
							{payloads.length > 1 ? (
								<NativeSegments
									value={active.key}
									onChange={setPayloadKey}
									options={payloads.map(({ key, label }) => ({ value: key, label }))}
								/>
							) : (
								<WebText recipe={styles.payloadLabel}>{active.label}</WebText>
							)}
							<ToolPayload key={active.key} value={active.value} />
						</WebView>
					</WebView>
				) : null}
			</WebView>
		</WebView>
	);
}

function ToolPayload({ value }: { value: string }) {
	const t = useI18n();
	const formatted = useMemo(() => formatToolPayload(value), [value]);
	const [limit, setLimit] = useState(12000);
	return (
		<WebView recipe={styles.payload}>
			<AppScrollView nestedScrollEnabled>
				<WebText recipe={webText(styles.payload)} selectable>
					{formatted.slice(0, limit)}
				</WebText>
			</AppScrollView>
			{formatted.length > limit ? (
				<Button variant="ghost" size="sm" onPress={() => setLimit((current) => current + 12000)}>
					<WebText recipe={styles.muted}>{t("timeline.moreText")}</WebText>
				</Button>
			) : null}
		</WebView>
	);
}
