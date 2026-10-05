import type { DashboardStats } from "@clawdi/shared/api";
import { thisWeekCardClasses as styles } from "@clawdi/shared/ui";
import { DASHBOARD_COPY, formatNumber, thisWeekModel } from "@clawdi/shared/view";
import { ApiErrorPanel } from "../api-error-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../card";
import { Skeleton } from "../skeleton";
import { WebText, WebView, webView } from "../web-layout";
export function ThisWeekCard({
	stats,
	error,
	onRetry,
}: {
	stats: DashboardStats | undefined;
	error?: unknown;
	onRetry?: () => void;
}) {
	const { ready, todaySessions, topModel, manualWeek, automatedWeek, streakLabel } =
		thisWeekModel(stats);
	return (
		<Card>
			<CardHeader>
				<CardTitle>{DASHBOARD_COPY.weeklyTitle}</CardTitle>
				<CardDescription>{DASHBOARD_COPY.weeklyDescription}</CardDescription>
			</CardHeader>
			<CardContent className={webView(styles.spaceY5)}>
				{error ? (
					<ApiErrorPanel error={error} onRetry={onRetry} title={DASHBOARD_COPY.weeklyError} />
				) : (
					<>
						<WebView recipe="" style={{ marginBottom: 12 }}>
							<WebText recipe={styles.textXsTextMutedForeground}>
								{DASHBOARD_COPY.yourSessions}
							</WebText>
							{ready && manualWeek !== undefined ? (
								<>
									<WebText recipe={styles.text3XlFontSemiboldTabular}>
										{formatNumber(manualWeek)}
									</WebText>
									{automatedWeek !== undefined && automatedWeek > 0 ? (
										<WebText recipe={styles.mt1TextXsText}>
											+ {formatNumber(automatedWeek)} automated (cron, heartbeat)
										</WebText>
									) : null}
								</>
							) : (
								<Skeleton className={webView(styles.h9W16)} />
							)}
						</WebView>
						<WebView recipe={styles.gridGridCols3Gap} className="flex-row">
							<SecondaryStat
								label={DASHBOARD_COPY.today}
								value={ready && todaySessions !== undefined ? formatNumber(todaySessions) : null}
							/>
							<SecondaryStat label={DASHBOARD_COPY.streak} value={streakLabel} />
							<SecondaryStat
								label={DASHBOARD_COPY.topModel}
								value={ready ? (topModel ?? "—") : null}
								small
							/>
						</WebView>
					</>
				)}
			</CardContent>
		</Card>
	);
}
function SecondaryStat({
	label,
	value,
	small,
}: {
	label: string;
	value: string | null;
	small?: boolean;
}) {
	return (
		<WebView recipe={styles.spaceY1} className="flex-1">
			<WebText recipe={styles.textXsTextMutedForeground}>{label}</WebText>
			{value === null ? (
				<Skeleton className={webView(styles.h5W10)} />
			) : (
				<WebText
					recipe={small ? styles.truncateTextSmFontMedium : styles.textBaseFontSemiboldTabular}
					numberOfLines={1}
				>
					{value}
				</WebText>
			)}
		</WebView>
	);
}
