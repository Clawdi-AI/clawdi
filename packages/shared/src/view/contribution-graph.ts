import type { ContributionDay } from "../api";
export function clampLevel(level: number): number {
	if (level < 0) return 0;
	if (level > 4) return 4;
	return Math.trunc(level);
}

/** Chunk chronological days into weeks (columns), padding the first week so
 * day[0] of the first column lines up with Sunday. */
export function parseCalendarDate(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const year = Number(match[1]);
	const monthIndex = Number(match[2]) - 1;
	const day = Number(match[3]);
	const date = new Date(year, monthIndex, day);
	if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) {
		return null;
	}
	return date;
}

export function buildWeeks(data: ContributionDay[]): ContributionDay[][] {
	if (!data.length) return [];
	const weeks: ContributionDay[][] = [];
	let current: ContributionDay[] = [];
	const startPad = parseCalendarDate(data[0].date)?.getDay() ?? 0;
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
export function computeMonthLabels(weeks: ContributionDay[][]): (string | null)[] {
	let prevMonth = -1;
	return weeks.map((week) => {
		const firstReal = week.find((d) => d.date);
		if (!firstReal) return null;
		const date = parseCalendarDate(firstReal.date);
		if (!date) return null;
		const month = date.getMonth();
		if (month === prevMonth) return null;
		prevMonth = month;
		return date.toLocaleString("en-US", { month: "short" });
	});
}
