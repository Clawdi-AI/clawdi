import type { ContributionDay } from "@clawdi/shared/api";
import {
	dashboardPageClasses as page,
	skeletonClassName,
	contributionGraphClasses as styles,
} from "@clawdi/shared/ui";
import {
	buildWeeks,
	clampLevel,
	computeMonthLabels,
	DASHBOARD_COPY,
	formatCount,
} from "@clawdi/shared/view";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";

const CELL = 11,
	GAP = 3,
	STRIDE = CELL + GAP,
	DAY_LABEL_W = 18;
const colors = [
	styles.inactiveActivity,
	styles.lowActivity,
	styles.mediumActivity,
	styles.highActivity,
	styles.peakActivity,
];
export function ContributionGraph({ data }: { data: ContributionDay[] }) {
	const t = useI18n();
	const [maxWeeks, setMaxWeeks] = useState(52);
	const weeks = buildWeeks(data).slice(-maxWeeks),
		labels = computeMonthLabels(weeks);
	if (!data.length) return <WebText recipe={styles.empty}>{DASHBOARD_COPY.noActivity}</WebText>;
	return (
		<WebView
			recipe={styles.root}
			onLayout={({ nativeEvent }) =>
				setMaxWeeks(
					Math.max(4, Math.floor((nativeEvent.layout.width - DAY_LABEL_W + GAP) / STRIDE)),
				)
			}
		>
			<WebView
				recipe={styles.graph}
				className="flex-row"
				style={{ width: DAY_LABEL_W + weeks.length * STRIDE - GAP }}
			>
				<WebView recipe={styles.weekdays} style={{ width: 12 }}>
					{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
						<WebText key={i} recipe={styles.weekdays} style={{ height: CELL, lineHeight: CELL }}>
							{d}
						</WebText>
					))}
				</WebView>
				<WebView recipe={styles.root} style={{ width: weeks.length * STRIDE - GAP }}>
					<WebView recipe={styles.weeks} className="flex-row">
						{weeks.map((week, wi) => (
							<WebView key={wi} recipe={styles.week}>
								{week.map((day, di) => (
									<WebView
										key={di}
										recipe={`${styles.cell} ${day.date ? colors[clampLevel(day.level)] : styles.placeholder}`}
										style={{ width: CELL, height: CELL }}
										accessibilityLabel={
											day.date
												? t("labels.sessionsOnDate", {
														sessions: formatCount(day.count, "session"),
														date: day.date,
													})
												: undefined
										}
									/>
								))}
							</WebView>
						))}
					</WebView>
					<WebView recipe={styles.months}>
						{labels.map((label, i) =>
							label && !labels[i + 1] ? (
								<WebText
									key={i}
									recipe={`${styles.months} ${styles.monthLabel}`}
									style={{ left: Math.min(i * STRIDE, weeks.length * STRIDE - 24), marginTop: 0 }}
								>
									{label}
								</WebText>
							) : null,
						)}
					</WebView>
				</WebView>
			</WebView>
		</WebView>
	);
}
export function ActivityGraphSkeleton() {
	const [maxWeeks, setMaxWeeks] = useState(20);
	return (
		<Skeleton className={webView(styles.placeholder)}>
			<WebView
				recipe={page.graphSkeleton}
				onLayout={({ nativeEvent }) =>
					setMaxWeeks(
						Math.max(4, Math.floor((nativeEvent.layout.width - DAY_LABEL_W + GAP) / STRIDE)),
					)
				}
			>
				<WebView recipe={page.graphSkeletonLayout} className="flex-row">
					<WebView recipe={page.graphSkeletonWeekdays}>
						{Array.from({ length: 7 }, (_, i) => (
							<WebView key={i} recipe={`${skeletonClassName} ${page.graphSkeletonWeekday}`} />
						))}
					</WebView>
					<WebView recipe={page.graphSkeletonBody}>
						<WebView recipe={page.graphSkeletonWeeks} className="flex-row">
							{Array.from({ length: maxWeeks }, (_, wi) => (
								<WebView key={wi} recipe={page.graphSkeletonWeek}>
									{Array.from({ length: 7 }, (_, di) => (
										<WebView
											key={di}
											recipe={`${skeletonClassName} ${page.graphSkeletonCell} ${(wi + di) % 5 === 0 ? page.graphSkeletonMutedCell : ""}`}
										/>
									))}
								</WebView>
							))}
						</WebView>
						<WebView recipe={page.graphSkeletonMonths} className="flex-row">
							{Array.from({ length: 6 }, (_, i) => (
								<WebView key={i} recipe={`${skeletonClassName} ${page.graphSkeletonMonth}`} />
							))}
						</WebView>
					</WebView>
				</WebView>
			</WebView>
		</Skeleton>
	);
}
