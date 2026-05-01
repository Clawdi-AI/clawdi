"use client";

import { agentTypeLabel } from "@/components/dashboard/agent-label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * Quick date-range filter chips for the sessions list. Mirrors the
 * Linear / Notion pattern: a tight row of preset windows next to
 * the search box, click-to-apply, click-again to clear (single-mode
 * ToggleGroup gives "active item is highlighted, click to toggle
 * off" semantics for free).
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

export const NO_DATE_FILTER: DateRange = { preset: null, since: null, until: null };

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

interface DateProps {
	value: DateRange;
	onChange: (range: DateRange) => void;
}

export function SessionDateFilter({ value, onChange }: DateProps) {
	return (
		<ToggleGroup
			type="single"
			variant="outline"
			size="sm"
			value={value.preset ?? ""}
			onValueChange={(v) => onChange(v ? computeRange(v as DateRangePreset) : NO_DATE_FILTER)}
			aria-label="Filter by date range"
		>
			{PRESETS.map((p) => (
				<ToggleGroupItem key={p.id} value={p.id} aria-label={p.label}>
					{p.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}

/**
 * Agent filter chips. Renders one chip per agent the user actually
 * has registered (derived from `/api/environments`), so single-
 * agent users don't see the filter at all (no value, just clutter).
 * Click to scope the list to that agent; click the same chip again
 * to clear (single-mode ToggleGroup behavior).
 *
 * Backend's `/api/sessions?agent=<type>` already supports this; the
 * chip is just the discoverable UI for it.
 */
interface AgentProps {
	value: string | null;
	onChange: (agent: string | null) => void;
	availableAgents: string[];
}

export function SessionAgentFilter({ value, onChange, availableAgents }: AgentProps) {
	if (availableAgents.length < 2) return null;
	return (
		<ToggleGroup
			type="single"
			variant="outline"
			size="sm"
			value={value ?? ""}
			onValueChange={(v) => onChange(v || null)}
			aria-label="Filter by agent"
		>
			{availableAgents.map((agent) => (
				<ToggleGroupItem key={agent} value={agent} aria-label={agentTypeLabel(agent)}>
					{agentTypeLabel(agent)}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}
