import type { ContributionDay } from "@clawdi/shared/api";
import {
	dashboardPageClasses as page,
	skeletonClassName,
	contributionGraphClasses as styles,
} from "@clawdi/shared/ui";
import { buildWeeks, clampLevel, computeMonthLabels, DASHBOARD_COPY } from "@clawdi/shared/view";
import { useState } from "react";
import { Skeleton } from "../skeleton";
import { WebText, WebView, webView } from "../web-layout";

const CELL = 11,
	GAP = 3,
	STRIDE = CELL + GAP,
	DAY_LABEL_W = 18;
const colors = [
	styles.bgPrimary10,
	styles.bgPrimary30,
	styles.bgPrimary50,
	styles.bgPrimary75,
	styles.bgPrimary,
];
export function ContributionGraph({ data }: { data: ContributionDay[] }) {
	const [maxWeeks, setMaxWeeks] = useState(52);
	const weeks = buildWeeks(data).slice(-maxWeeks),
		labels = computeMonthLabels(weeks);
	if (!data.length)
		return <WebText recipe={styles.textSmTextMutedForeground}>{DASHBOARD_COPY.noActivity}</WebText>;
	return (
		<WebView
			recipe={styles.wFull}
			onLayout={({ nativeEvent }) =>
				setMaxWeeks(
					Math.max(4, Math.floor((nativeEvent.layout.width - DAY_LABEL_W + GAP) / STRIDE)),
				)
			}
		>
			<WebView
				recipe={styles.mxAutoFlexWFit}
				className="flex-row"
				style={{ width: DAY_LABEL_W + weeks.length * STRIDE - GAP }}
			>
				<WebView recipe={styles.flexShrink0FlexCol} style={{ width: 12 }}>
					{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
						<WebText
							key={i}
							recipe={styles.flexShrink0FlexCol}
							style={{ height: CELL, lineHeight: CELL }}
						>
							{d}
						</WebText>
					))}
				</WebView>
				<WebView recipe={styles.wFull} style={{ width: weeks.length * STRIDE - GAP }}>
					<WebView recipe={styles.flexGap3Px} className="flex-row">
						{weeks.map((week, wi) => (
							<WebView key={wi} recipe={styles.flexFlexColGap3Px}>
								{week.map((day, di) => (
									<WebView
										key={di}
										recipe={`${styles.rounded3Px} ${day.date ? colors[clampLevel(day.level)] : styles.bgTransparent}`}
										style={{ width: CELL, height: CELL }}
										accessibilityLabel={
											day.date ? `${day.count} sessions on ${day.date}` : undefined
										}
									/>
								))}
							</WebView>
						))}
					</WebView>
					<WebView recipe={styles.relativeMt1H4}>
						{labels.map((label, i) =>
							label && !labels[i + 1] ? (
								<WebText
									key={i}
									recipe={`${styles.relativeMt1H4} ${styles.absoluteWhitespaceNowrap}`}
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
		<Skeleton className={webView(styles.bgTransparent)}>
			<WebView
				recipe={page.wFull}
				onLayout={({ nativeEvent }) =>
					setMaxWeeks(
						Math.max(4, Math.floor((nativeEvent.layout.width - DAY_LABEL_W + GAP) / STRIDE)),
					)
				}
			>
				<WebView recipe={page.flexGap15} className="flex-row">
					<WebView recipe={page.flexW3Shrink0}>
						{Array.from({ length: 7 }, (_, i) => (
							<WebView key={i} recipe={`${skeletonClassName} ${page.h11PxW2Rounded}`} />
						))}
					</WebView>
					<WebView recipe={page.minW0Flex1}>
						<WebView recipe={page.flexMaxH95PxOverflow} className="flex-row">
							{Array.from({ length: maxWeeks }, (_, wi) => (
								<WebView key={wi} recipe={page.flexFlexColGap3Px}>
									{Array.from({ length: 7 }, (_, di) => (
										<WebView
											key={di}
											recipe={`${skeletonClassName} ${page.size11PxRounded3Px} ${(wi + di) % 5 === 0 ? page.opacity50 : ""}`}
										/>
									))}
								</WebView>
							))}
						</WebView>
						<WebView recipe={page.mt1FlexH4} className="flex-row">
							{Array.from({ length: 6 }, (_, i) => (
								<WebView key={i} recipe={`${skeletonClassName} ${page.h25W6}`} />
							))}
						</WebView>
					</WebView>
				</WebView>
			</WebView>
		</Skeleton>
	);
}
