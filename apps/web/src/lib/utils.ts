import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function relativeTime(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(dateStr).toLocaleDateString();
}

export function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
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
