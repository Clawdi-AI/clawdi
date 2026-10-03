import { type SessionTimelineRow, splitSearchHighlight } from "@clawdi/shared/api";
import { router } from "expo-router";
import { useState } from "react";
import { useI18n } from "../i18n";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppView } from "../ui/primitives";
import { formatDate } from "./cloud-inventory";

function Payload({ value, query }: { value: string; query?: string }) {
	const t = useI18n();
	const [limit, setLimit] = useState(12000);
	return (
		<>
			<AppText selectable className="text-base leading-6 text-foreground">
				{splitSearchHighlight(value.slice(0, limit), query ?? "").map((part, index) => (
					<AppText
						key={`${index}:${part.highlighted}`}
						className={part.highlighted ? "bg-warning text-foreground" : "text-foreground"}
					>
						{part.text}
					</AppText>
				))}
			</AppText>
			{value.length > limit ? (
				<NativeButton label={t("timeline.moreText")} onPress={() => setLimit(limit + 12000)} />
			) : null}
		</>
	);
}

export function TimelineRow({
	row,
	sessionId,
	highlighted,
	query,
	disabled,
}: {
	row: SessionTimelineRow;
	sessionId: string;
	highlighted: boolean;
	query?: string;
	disabled: boolean;
}) {
	const t = useI18n();
	const [expanded, setExpanded] = useState(false);
	const timestamp = row.kind === "message" ? row.message.timestamp : row.firstTimestamp;
	const position =
		row.kind === "message" && "position" in row.message ? row.message.position : undefined;
	return (
		<AppView
			className={`gap-2 rounded-2xl p-4 ${highlighted ? "border-2 border-primary bg-surface" : "bg-surface"}`}
		>
			{highlighted ? <AppText accessibilityRole="header">{t("timeline.current")}</AppText> : null}
			<AppText className="text-base font-semibold text-foreground">
				{row.kind === "message"
					? t(row.message.role === "user" ? "sessions.user" : "sessions.assistant")
					: (row.call?.name ?? row.result?.name ?? t("timeline.tool"))}
			</AppText>
			{formatDate(timestamp) ? (
				<AppText className="text-sm text-muted">{formatDate(timestamp)}</AppText>
			) : null}
			{row.kind === "message" ? (
				<>
					<Payload value={row.message.content} query={query} />
					{position !== undefined ? (
						<>
							<NativeButton
								label={t("sessionShares.through")}
								disabled={disabled}
								onPress={() =>
									router.push({
										pathname: "/sessions/shared",
										params: { sessionId, scope: "through", position: String(position) },
									})
								}
							/>
							{row.message.role === "assistant" ? (
								<NativeButton
									label={t("sessionShares.response")}
									disabled={disabled}
									onPress={() =>
										router.push({
											pathname: "/sessions/shared",
											params: {
												sessionId,
												scope: "response",
												position: String(position),
											},
										})
									}
								/>
							) : null}
						</>
					) : null}
				</>
			) : (
				<>
					<AppText>
						{t(
							row.result?.status === "error"
								? "timeline.failed"
								: row.result
									? "timeline.completed"
									: "timeline.pending",
						)}
					</AppText>
					<NativeButton
						label={t(expanded ? "timeline.hide" : "timeline.details")}
						onPress={() => setExpanded(!expanded)}
					/>
					{expanded ? (
						<>
							{row.call?.arguments_json ? (
								<>
									<AppText>{t("timeline.arguments")}</AppText>
									<Payload value={row.call.arguments_json} />
								</>
							) : null}
							{row.result?.content ? (
								<>
									<AppText>{t("timeline.output")}</AppText>
									<Payload value={row.result.content} />
								</>
							) : null}
							{row.result?.result_json ? (
								<>
									<AppText>{t("timeline.result")}</AppText>
									<Payload value={row.result.result_json} />
								</>
							) : null}
						</>
					) : null}
				</>
			)}
		</AppView>
	);
}
