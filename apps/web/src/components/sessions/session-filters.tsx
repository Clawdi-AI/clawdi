/**
 * Filter data + helpers for the sessions list. Pure data — the
 * actual UI is the shadcn `DataTableFacetedFilter` shipped in
 * `components/ui/data-table-faceted-filter.tsx`, which the page
 * wires up in its toolbar.
 */

export type DateRangePreset = "today" | "yesterday" | "7d" | "30d";

export interface DateRange {
	preset: DateRangePreset | null;
	since: string | null;
	until: string | null;
}

export const NO_DATE_FILTER: DateRange = { preset: null, since: null, until: null };

export function computeRange(preset: DateRangePreset, now = new Date()): DateRange {
	// Local-time day boundaries so "Today" matches the user's
	// calendar day, not UTC. Backend's TIMESTAMPTZ comparison is
	// timezone-aware so the conversion is one-way safe.
	const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
	const today = startOfDay(now);
	const tomorrow = new Date(today.getTime() + 86_400_000);
	switch (preset) {
		case "today":
			return { preset, since: today.toISOString(), until: tomorrow.toISOString() };
		case "yesterday": {
			const yesterday = new Date(today.getTime() - 86_400_000);
			return { preset, since: yesterday.toISOString(), until: today.toISOString() };
		}
		case "7d":
			return {
				preset,
				since: new Date(today.getTime() - 6 * 86_400_000).toISOString(),
				until: tomorrow.toISOString(),
			};
		case "30d":
			return {
				preset,
				since: new Date(today.getTime() - 29 * 86_400_000).toISOString(),
				until: tomorrow.toISOString(),
			};
	}
}

export const DATE_FILTER_OPTIONS: { label: string; value: DateRangePreset }[] = [
	{ label: "Today", value: "today" },
	{ label: "Yesterday", value: "yesterday" },
	{ label: "Last 7 days", value: "7d" },
	{ label: "Last 30 days", value: "30d" },
];
