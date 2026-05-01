"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Quick date-range filter chips for the sessions list. Mirrors the
 * Linear / Notion pattern: a tight row of preset windows next to
 * the search box, click-to-apply, click-again or X to clear.
 *
 * Range semantics mirror the backend's `since` (inclusive) /
 * `until` (exclusive) query params so the URL state and the chip
 * state stay in sync. Each preset computes both bounds at
 * click-time (relative to "now") rather than baking them into the
 * URL — that way "Last 7 days" stays accurate as the user leaves
 * the page open over midnight.
 */

export type DateRangePreset = "today" | "yesterday" | "7d" | "30d";

export interface DateRange {
	preset: DateRangePreset | null;
	since: string | null;
	until: string | null;
}

const EMPTY_RANGE: DateRange = { preset: null, since: null, until: null };

export const NO_DATE_FILTER: DateRange = EMPTY_RANGE;

export function computeRange(preset: DateRangePreset, now = new Date()): DateRange {
	// All bounds are computed in local time so "Today" matches the
	// user's calendar day, not UTC. Backend treats them as ISO and
	// compares against `last_activity_at` (UTC-stored TIMESTAMPTZ),
	// which is timezone-aware on Postgres.
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

const PRESETS: { id: DateRangePreset; label: string }[] = [
	{ id: "today", label: "Today" },
	{ id: "yesterday", label: "Yesterday" },
	{ id: "7d", label: "Last 7 days" },
	{ id: "30d", label: "Last 30 days" },
];

interface Props {
	value: DateRange;
	onChange: (range: DateRange) => void;
}

export function SessionDateFilter({ value, onChange }: Props) {
	const active = value.preset;
	return (
		<div className="flex items-center gap-1">
			{PRESETS.map((p) => {
				const isActive = active === p.id;
				return (
					<Button
						key={p.id}
						type="button"
						variant={isActive ? "default" : "outline"}
						size="sm"
						className={cn("h-8 text-xs", isActive && "shadow-sm")}
						onClick={() => onChange(isActive ? NO_DATE_FILTER : computeRange(p.id))}
					>
						{p.label}
					</Button>
				);
			})}
			{active ? (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-8 text-xs text-muted-foreground"
					onClick={() => onChange(NO_DATE_FILTER)}
					aria-label="Clear date filter"
				>
					<X className="size-3" />
				</Button>
			) : null}
		</div>
	);
}
