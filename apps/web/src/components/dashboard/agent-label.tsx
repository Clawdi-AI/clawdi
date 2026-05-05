import type { ReactNode } from "react";
import { AgentIcon, type AgentIconSize } from "@/components/dashboard/agent-icon";
import { cn } from "@/lib/utils";

/** Single-line, inline-flow agent identity for meta rows where
 * the parent layout is `text` rather than `flex column` (e.g.
 * the session detail header where icon+name+type sits next to
 * project path and timestamp on one line). Wraps the same
 * cleanMachineName + agentTypeLabel logic the block-form
 * `<AgentLabel>` uses, so the inline and block variants stay
 * in lockstep. */
export function AgentInline({
	machineName,
	type,
	className,
}: {
	machineName: string | null | undefined;
	type: string | null | undefined;
	className?: string;
}) {
	const machine = cleanMachineName(machineName);
	const typeLabel = agentTypeLabel(type);
	const title = machine || typeLabel;
	const subtitle = machine && type ? typeLabel : null;
	if (!machine && !type) return null;
	return (
		<span className={cn("inline-flex items-center gap-1.5", className)}>
			<AgentIcon agent={type} size="xs" />
			<span className="font-medium text-foreground">{title}</span>
			{subtitle ? <span>· {subtitle}</span> : null}
		</span>
	);
}

/**
 * Canonical display for an Agent across the app.
 *
 * Used everywhere an agent shows up: sessions table row, overview
 * grid tile, agent detail hero, picker trigger and dropdown rows,
 * Cmd+K results. If you find yourself rendering "icon + machine
 * name + agent type" inline, reach for this first.
 *
 * Two layout variants — picked by `primary` — so the same component
 * fits both "many agents on one screen" and "one agent in a hero":
 *
 *   primary="machine"  (default — every list and the detail hero)
 *     [icon] Jings-MacBook-Pro.local
 *            Hermes · meta…
 *     The machine name is the H1 because that's the label the
 *     user picked themselves; agent_type drops to the subtitle
 *     where it disambiguates 4 agents on the same laptop.
 *
 *   primary="type"
 *     [icon] Hermes
 *            Jings-MacBook-Pro.local · meta…
 *     The agent_type is the H1. Reach for this only when the
 *     surface specifically NEEDS the type to lead — e.g. a picker
 *     of agent kinds rather than agent instances.
 *
 * `meta` is an inline slot for "Active 11m ago", DaemonStatusBadge,
 * etc. Compact surfaces keep it in the subtitle row; tiles and
 * heroes can move it to a dedicated wrapping row.
 */

const TYPE_LABEL: Record<string, string> = {
	claude_code: "Claude Code",
	codex: "Codex",
	hermes: "Hermes",
	openclaw: "OpenClaw",
};

export function agentTypeLabel(type: string | null | undefined): string {
	if (!type) return "Unknown";
	return TYPE_LABEL[type] ?? type;
}

/** Strip mDNS-style suffixes (`.local`, `.lan`) from a hostname.
 * Bonjour appends `.local` automatically on macOS — the user
 * never typed it, never thinks about it, and showing it just
 * eats column width without conveying any information. */
export function cleanMachineName(raw: string | null | undefined): string {
	if (!raw) return "";
	return raw.replace(/\.(local|lan)$/i, "");
}

const NAME_CLASS: Record<AgentIconSize, string> = {
	xs: "text-xs font-medium",
	sm: "text-sm font-medium",
	md: "text-sm font-medium",
	lg: "text-base font-medium",
	xl: "text-2xl font-semibold tracking-tight",
};

// Tighter line-height + smaller subtitle gap on hero size so the
// icon and the text block balance optically — `text-2xl` titles
// against a default `leading-normal` left a too-loose stack.
const SUBTITLE_GAP: Record<AgentIconSize, string> = {
	xs: "mt-0",
	sm: "mt-0.5",
	md: "mt-0.5",
	lg: "mt-0.5",
	xl: "mt-1",
};

export function AgentLabel({
	machineName,
	type,
	size = "sm",
	primary = "machine",
	meta,
	titleAdornment,
	className,
}: {
	machineName: string | null | undefined;
	type: string | null | undefined;
	size?: AgentIconSize;
	/** Which field is the H1 line. Defaults to "machine" — the
	 * machine name is the user's own label; agent_type drops to
	 * the subtitle as a disambiguator. */
	primary?: "type" | "machine";
	/** Inline meta items rendered in the subtitle row after the
	 * primary disambiguator (e.g. last-seen, DaemonStatusBadge).
	 * Falsy entries are filtered. The whole row uses flex-wrap +
	 * per-segment whitespace-nowrap so wrap breaks at segment
	 * boundaries — no orphaned `·` separators or mid-word cuts. */
	meta?: ReactNode[];
	/** Tag rendered immediately to the right of the title — for
	 * identity-level adornments that aren't meta-data (e.g. a
	 * "Clawdi-hosted" pill). Goes here, not in meta, so it stays
	 * with the name as a single visual unit no matter how the
	 * subtitle wraps. */
	titleAdornment?: ReactNode;
	className?: string;
}) {
	const typeLabel = agentTypeLabel(type);
	const cleanedMachine = cleanMachineName(machineName);
	const titleText = primary === "type" ? typeLabel : cleanedMachine || typeLabel;
	// The disambiguator is the OTHER field — when title is the type
	// we surface the machine name (and vice versa). Suppressed if
	// it'd duplicate the title (e.g. hosted-on-Clawdi tiles whose
	// `machineName` is just the runtime label "Hermes" — disambig
	// would print "Hermes" again under the title).
	const rawDisambig =
		primary === "type" ? cleanedMachine : type && cleanedMachine ? typeLabel : null;
	const disambiguator = rawDisambig && rawDisambig !== titleText ? rawDisambig : null;

	const filteredMeta = (meta ?? []).filter((m) => m !== null && m !== undefined && m !== false);
	const subtitleSegments: ReactNode[] = [];
	if (disambiguator) subtitleSegments.push(disambiguator);
	for (const m of filteredMeta) subtitleSegments.push(m);

	return (
		<div className={cn("flex min-w-0 items-center gap-3", className)}>
			<AgentIcon agent={type} size={size} />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className={cn("truncate leading-tight", NAME_CLASS[size])} title={titleText}>
						{titleText}
					</span>
					{titleAdornment ? <span className="shrink-0">{titleAdornment}</span> : null}
				</div>
				{subtitleSegments.length > 0 ? (
					<div
						className={cn(
							"flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground",
							SUBTITLE_GAP[size],
						)}
					>
						{subtitleSegments.map((seg, i) => (
							<span key={`seg-${i}`} className="inline-flex items-center whitespace-nowrap">
								{seg}
							</span>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
