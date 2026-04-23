"use client";

import { useEffect, useRef, useState } from "react";
import type { ContributionDay } from "@/lib/api-schemas";
import { cn } from "@/lib/utils";

// A theme-agnostic density ramp. Empty days use a faint tint of `--primary`
// so the heatmap reads the same way across light/dark modes regardless of
// what role `--secondary` or `--muted` happen to play in any given palette.
const LEVEL_COLORS = [
	"bg-primary/10",
	"bg-primary/30",
	"bg-primary/50",
	"bg-primary/75",
	"bg-primary",
];

const CELL = 11; // px, matches GitHub's ~11px heatmap cell
const GAP = 3; // px gap between cells and columns
const WEEK_STRIDE = CELL + GAP; // horizontal distance from one week's column to the next
const DAY_LABEL_W = 28; // px reserved for "Mon"/"Wed"/"Fri" labels on the left
const MIN_WEEKS = 4; // never show fewer than a month of data, even on tiny viewports

function clampLevel(level: number): number {
	if (level < 0) return 0;
	if (level > 4) return 4;
	return Math.trunc(level);
}

/** Chunk chronological days into weeks (columns), padding the first week so
 * day[0] of the first column lines up with Sunday. */
function buildWeeks(data: ContributionDay[]): ContributionDay[][] {
	if (!data.length) return [];
	const weeks: ContributionDay[][] = [];
	let current: ContributionDay[] = [];
	const startPad = new Date(data[0].date).getDay();
	for (let i = 0; i < startPad; i++) {
		current.push({ date: "", count: 0, level: 0 });
	}
	for (const day of data) {
		current.push(day);
		if (current.length === 7) {
			weeks.push(current);
			current = [];
		}
	}
	if (current.length > 0) weeks.push(current);
	return weeks;
}

/** For each week column, return the month short-name if that week is the
 * first one to contain a day from a new month (so we draw one label per
 * month, like GitHub). Returns null for columns that shouldn't label. */
function computeMonthLabels(weeks: ContributionDay[][]): (string | null)[] {
	let prevMonth = -1;
	return weeks.map((week) => {
		const firstReal = week.find((d) => d.date);
		if (!firstReal) return null;
		const month = new Date(firstReal.date).getMonth();
		if (month === prevMonth) return null;
		prevMonth = month;
		return new Date(firstReal.date).toLocaleString("en-US", { month: "short" });
	});
}

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
		return <div className="text-sm text-muted-foreground">No activity data yet.</div>;
	}

	const allWeeks = buildWeeks(data);
	const weeks = allWeeks.slice(-maxWeeks);
	const monthLabels = computeMonthLabels(weeks);

	return (
		<div ref={containerRef} className="w-full">
			<div className="flex gap-1.5">
				{/* Day-of-week labels: only label odd rows so they don't overflow the cell heights. */}
				<div
					className="flex shrink-0 flex-col gap-[3px] pt-5 text-[10px] text-muted-foreground tabular-nums"
					style={{ width: DAY_LABEL_W - 6 }}
					aria-hidden
				>
					<span style={{ height: CELL }} />
					<span style={{ height: CELL, lineHeight: `${CELL}px` }}>Mon</span>
					<span style={{ height: CELL }} />
					<span style={{ height: CELL, lineHeight: `${CELL}px` }}>Wed</span>
					<span style={{ height: CELL }} />
					<span style={{ height: CELL, lineHeight: `${CELL}px` }}>Fri</span>
					<span style={{ height: CELL }} />
				</div>

				<div className="min-w-0 flex-1">
					{/* Month labels, positioned absolutely above the week they start. */}
					<div className="relative mb-1 h-4 text-[10px] leading-4 text-muted-foreground">
						{monthLabels.map((m, i) =>
							m ? (
								<span
									key={i}
									className="absolute whitespace-nowrap"
									style={{ left: i * WEEK_STRIDE }}
								>
									{m}
								</span>
							) : null,
						)}
					</div>

					{/* Week columns grid. */}
					<div className="flex gap-[3px]">
						{weeks.map((week, wi) => (
							<div key={wi} className="flex flex-col gap-[3px]">
								{week.map((day, di) => (
									<div
										key={di}
										className={cn(
											"rounded-sm",
											day.date ? LEVEL_COLORS[clampLevel(day.level)] : "bg-transparent",
										)}
										style={{ width: CELL, height: CELL }}
										title={day.date ? `${day.count} sessions on ${day.date}` : undefined}
									/>
								))}
							</div>
						))}
					</div>
				</div>
			</div>

			{/* Legend, right-aligned like GitHub's. */}
			<div className="mt-3 flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
				<span>Less</span>
				{LEVEL_COLORS.map((c, i) => (
					<div key={i} className={cn("rounded-sm", c)} style={{ width: CELL, height: CELL }} />
				))}
				<span>More</span>
			</div>
		</div>
	);
}
