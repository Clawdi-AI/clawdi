"use client";

import { contributionGraphClasses } from "@clawdi/shared/ui";

import { buildWeeks, clampLevel, computeMonthLabels, DASHBOARD_COPY } from "@clawdi/shared/view";

import { useEffect, useRef, useState } from "react";
import type { ContributionDay } from "@/lib/api-schemas";
import { cn } from "@/lib/utils";

// A theme-agnostic density ramp. Empty days use a faint tint of `--primary`
// so the heatmap reads the same way across light/dark modes regardless of
// what role `--secondary` or `--muted` happen to play in any given palette.
const LEVEL_COLORS = [
	contributionGraphClasses.bgPrimary10,
	contributionGraphClasses.bgPrimary30,
	contributionGraphClasses.bgPrimary50,
	contributionGraphClasses.bgPrimary75,
	contributionGraphClasses.bgPrimary,
];

const CELL = 11; // px, matches GitHub's ~11px heatmap cell
const GAP = 3; // px gap between cells and columns
const WEEK_STRIDE = CELL + GAP; // horizontal distance from one week's column to the next
const DAY_LABEL_W = 18; // px reserved for single-letter weekday labels and their gap
const MIN_WEEKS = 4; // never show fewer than a month of data, even on tiny viewports

export function ContributionGraph({ data }: { data: ContributionDay[] }) {
	const containerRef = useRef<HTMLDivElement>(null);
	// Start with a safe default before ResizeObserver fires (SSR / first paint).
	const [maxWeeks, setMaxWeeks] = useState(52);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const w = entries[0].contentRect.width - DAY_LABEL_W;
			const weeks = Math.max(MIN_WEEKS, Math.floor((w + GAP) / WEEK_STRIDE));
			setMaxWeeks(weeks);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	if (!data.length) {
		return (
			<div className={contributionGraphClasses.textSmTextMutedForeground}>
				{DASHBOARD_COPY.noActivity}
			</div>
		);
	}

	const allWeeks = buildWeeks(data);
	const weeks = allWeeks.slice(-maxWeeks);
	const monthLabels = computeMonthLabels(weeks);

	return (
		<div ref={containerRef} className={contributionGraphClasses.wFull}>
			<div className={contributionGraphClasses.mxAutoFlexWFit}>
				{/* Weekday labels align with the Sunday-first rows. */}
				<div
					className={contributionGraphClasses.flexShrink0FlexCol}
					style={{ width: DAY_LABEL_W - 6 }}
					aria-hidden
				>
					{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => (
						<span key={index} style={{ height: CELL, lineHeight: `${CELL}px` }}>
							{day}
						</span>
					))}
				</div>

				<div style={{ width: weeks.length * WEEK_STRIDE - GAP }}>
					{/* Week columns grid. */}
					<div className={contributionGraphClasses.flexGap3Px}>
						{weeks.map((week, wi) => (
							<div key={wi} className={contributionGraphClasses.flexFlexColGap3Px}>
								{week.map((day, di) => (
									<div
										key={di}
										className={cn(
											contributionGraphClasses.rounded3Px,
											day.date
												? LEVEL_COLORS[clampLevel(day.level)]
												: contributionGraphClasses.bgTransparent,
										)}
										style={{ width: CELL, height: CELL }}
										title={day.date ? `${day.count} sessions on ${day.date}` : undefined}
									/>
								))}
							</div>
						))}
					</div>
					{/* Keep the final month inside the row; omit a partial first month if its label would overlap the next. */}
					<div className={contributionGraphClasses.relativeMt1H4}>
						{monthLabels.map((m, i) =>
							m && !monthLabels[i + 1] ? (
								<span
									key={i}
									className={contributionGraphClasses.absoluteWhitespaceNowrap}
									style={{ left: `min(${i * WEEK_STRIDE}px, calc(100% - 3ch))` }}
								>
									{m}
								</span>
							) : null,
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
