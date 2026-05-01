import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Compact "time ago" / absolute date hybrid for table cells and meta
 * lines. Default cutoff is 7 days — matches Linear / GitHub / Notion
 * for "this is recent" vs "this needs a real date". Older than 7d
 * gets a short absolute form (`Apr 28 14:30` for current year,
 * `Mar 15 2025` cross-year), so users can tell at-a-glance whether
 * a session was last week or last month without hovering.
 */
export function relativeTime(dateStr: string | null | undefined): string {
	// Defensive: callers go through this with values from API
	// responses, and during a deploy window a cached response might
	// be missing a field that the new frontend reads as required.
	// Invalid Date math returns NaN and the absolute branches print
	// "Invalid Date" — surface a stable em-dash instead so the table
	// stays readable.
	if (!dateStr) return "—";
	const d = new Date(dateStr);
	if (Number.isNaN(d.getTime())) return "—";
	const diff = Date.now() - d.getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	const now = new Date();
	const sameYear = d.getFullYear() === now.getFullYear();
	if (sameYear) {
		// "Apr 28 14:30" — short month + 24h time, locale-aware
		return d.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
	}
	// Cross-year: drop the time, prepend the year ("Mar 15 2025")
	return d.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/**
 * Full absolute timestamp for `title` tooltips. Pairs with
 * `relativeTime` cells: cell is short (`3h ago` / `Apr 28 14:30`),
 * tooltip is unambiguous (`Friday, Apr 30, 2026, 14:32:18 GMT+8`).
 */
export function formatAbsoluteTooltip(dateStr: string | null | undefined): string {
	if (!dateStr) return "—";
	const d = new Date(dateStr);
	if (Number.isNaN(d.getTime())) return "—";
	return d.toLocaleString(undefined, {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});
}

/**
 * Recency bucket used by the session list to group rows under
 * headers (Today / Yesterday / Previous 7 days / Previous 30 days /
 * older monthly buckets, then yearly). Matches the ChatGPT and
 * Claude.ai conversation-list patterns; the goal is "scan to the
 * bucket I care about, then scan within it" instead of squinting at
 * 25 individual timestamps.
 *
 * Returns a stable key (e.g. "today", "2026-04", "2025") that can
 * also serve as a React key for the bucket header row.
 */
export interface RecencyBucket {
	key: string;
	label: string;
}

export function recencyBucketFor(dateStr: string, now = new Date()): RecencyBucket {
	const d = new Date(dateStr);
	const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
	const today = startOfDay(now);
	const dayDiff = Math.floor((today.getTime() - startOfDay(d).getTime()) / 86_400_000);
	if (dayDiff <= 0) return { key: "today", label: "Today" };
	if (dayDiff === 1) return { key: "yesterday", label: "Yesterday" };
	if (dayDiff < 7) return { key: "previous-7d", label: "Previous 7 days" };
	if (dayDiff < 30) return { key: "previous-30d", label: "Previous 30 days" };
	const sameYear = d.getFullYear() === now.getFullYear();
	if (sameYear) {
		// "April 2026" — by month, current year only.
		const label = d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
		return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label };
	}
	// Cross-year: bucket by year so the list doesn't explode into 12
	// month-headers per old year.
	return { key: String(d.getFullYear()), label: String(d.getFullYear()) };
}

export function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === "string") return e;
	return "Something went wrong.";
}

const COMMAND_TAG_RE = /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/g;

/**
 * Turn a raw session summary into something readable for list rows and headers.
 *
 * Claude Code slash commands come through as XML-tagged user messages like
 *   <command-message>foo</command-message><command-name>/foo</command-name><command-args>bar</command-args>
 * which look awful rendered raw. Collapse them to `/foo bar`.
 */
export function formatSessionSummary(summary: string | null | undefined): string {
	if (!summary) return "";
	const nameMatch = summary.match(/<command-name>([\s\S]*?)<\/command-name>/);
	if (nameMatch) {
		const argsMatch = summary.match(/<command-args>([\s\S]*?)<\/command-args>/);
		const name = nameMatch[1].trim();
		const args = argsMatch?.[1].trim();
		const remaining = summary.replace(COMMAND_TAG_RE, "").trim();
		return [name, args, remaining].filter(Boolean).join(" ");
	}
	return summary;
}
