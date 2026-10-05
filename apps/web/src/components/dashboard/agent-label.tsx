import { agentSourceBadgeClasses, sessionAgentInlineClasses } from "@clawdi/shared/ui";
import {
	type AgentSourceKind,
	agentIdentity,
	agentSourceDescription,
	agentSourceLabel,
	agentTypeLabel,
	cleanAgentName,
	cleanMachineName,
} from "@clawdi/shared/view";
import { Cloud, History, Laptop } from "lucide-react";
import type { ReactNode } from "react";
import { AgentIcon, type AgentIconSize } from "@/components/dashboard/agent-icon";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
	type AgentOwnershipKind,
	agentOwnershipKindFromId,
	useAgentOwnership,
} from "@/lib/agent-ownership";
import { cn } from "@/lib/utils";

/** Single-line Agent name for compact meta rows. Runtime belongs in a
 * separate metadata field; it is never appended to the canonical name. */
export function AgentInline({
	name,
	displayName,
	defaultName,
	machineName,
	type,
	className,
}: {
	name?: string | null | undefined;
	displayName?: string | null | undefined;
	defaultName?: string | null | undefined;
	machineName: string | null | undefined;
	type: string | null | undefined;
	className?: string;
}) {
	const hasIdentity = Boolean(
		cleanAgentName(displayName) ||
			cleanAgentName(defaultName) ||
			cleanAgentName(name) ||
			cleanMachineName(machineName) ||
			type,
	);
	const identity = agentIdentity({
		name,
		display_name: displayName,
		default_name: defaultName,
		machine_name: machineName,
		agent_type: type,
	});
	const title = identity.primaryLabel;
	if (!hasIdentity) return null;
	return (
		<span className={cn(sessionAgentInlineClasses.root, className)}>
			<AgentIcon agent={type} size="xs" />
			<span className={sessionAgentInlineClasses.label}>{title}</span>
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
 *     [icon] Research Agent
 *            Hermes · meta…
 *     The canonical agent name is the H1: display override,
 *     default Agent name, API name alias, machine metadata, then
 *     runtime fallback. agent_type drops to the subtitle where it
 *     disambiguates sibling runtimes.
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

function sourceFromOwnershipKind(kind: AgentOwnershipKind): AgentSourceKind | null {
	if (kind === "unresolved") return null;
	return kind === "cloud" ? "hosted" : "connected";
}

export function AgentSourceBadge({
	source,
	compact = false,
	iconOnly = false,
	className,
}: {
	source: AgentSourceKind;
	compact?: boolean;
	iconOnly?: boolean;
	className?: string;
}) {
	const Icon = source === "hosted" ? Cloud : Laptop;
	const label = agentSourceLabel(source);
	const title = agentSourceDescription(source);
	const iconClass = source === "hosted" ? "text-info-muted-foreground" : "text-muted-foreground";
	// Solid silhouette at badge sizes: the outline cloud dissolves under ~16px.
	const iconFill = source === "hosted" ? "currentColor" : "none";
	return (
		<StatusBadge
			status="neutral"
			title={title}
			className={cn(
				agentSourceBadgeClasses.base,
				iconOnly
					? agentSourceBadgeClasses.iconOnly
					: compact
						? agentSourceBadgeClasses.compact
						: agentSourceBadgeClasses.regular,
				source === "hosted" ? agentSourceBadgeClasses.hosted : agentSourceBadgeClasses.connected,
				className,
			)}
		>
			<Icon
				className={cn(iconOnly ? "!size-3.5" : agentSourceBadgeClasses.icon, iconClass)}
				fill={iconFill}
			/>
			{iconOnly ? <span className="sr-only">{label}</span> : label}
		</StatusBadge>
	);
}

export function LegacyAgentBadge({
	compact = false,
	iconOnly = false,
	className,
}: {
	compact?: boolean;
	iconOnly?: boolean;
	className?: string;
}) {
	return (
		<StatusBadge
			status="neutral"
			title="Managed in the legacy hosted dashboard"
			className={cn(
				agentSourceBadgeClasses.legacy,
				iconOnly
					? agentSourceBadgeClasses.iconOnly
					: compact
						? agentSourceBadgeClasses.compact
						: agentSourceBadgeClasses.regular,
				className,
			)}
		>
			<History
				className={cn(
					iconOnly ? "!size-3.5" : agentSourceBadgeClasses.icon,
					"text-warning-muted-foreground",
				)}
			/>
			{iconOnly ? <span className="sr-only">Legacy</span> : "Legacy"}
		</StatusBadge>
	);
}

export function AgentSourceBadgeForEnvironment({
	env,
	ownershipKind,
	compact,
	iconOnly,
	showConnected = false,
	className,
}: {
	env: {
		id?: string | null;
	};
	ownershipKind?: AgentOwnershipKind;
	compact?: boolean;
	iconOnly?: boolean;
	showConnected?: boolean;
	className?: string;
}) {
	const ownership = useAgentOwnership();
	const kind = ownershipKind ?? agentOwnershipKindFromId(env.id, ownership);
	if (kind === "unresolved") {
		return (
			<Skeleton aria-label="Agent source loading" className={agentSourceBadgeClasses.loading} />
		);
	}
	if (kind === "legacy") {
		if (iconOnly) return null;
		return <LegacyAgentBadge compact={compact} className={className} />;
	}
	const source = sourceFromOwnershipKind(kind);
	if (!source) return null;
	if (source === "connected" && !showConnected) return null;
	return (
		<AgentSourceBadge source={source} compact={compact} iconOnly={iconOnly} className={className} />
	);
}

const NAME_CLASS: Record<AgentIconSize, string> = {
	xs: "text-xs font-medium",
	sm: "text-sm font-medium",
	md: "text-sm font-medium",
	lg: "text-base font-medium",
	rail: "text-base font-medium",
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
	rail: "mt-0.5",
	xl: "mt-1",
};

export function AgentLabel({
	name,
	machineName,
	displayName,
	defaultName,
	type,
	avatarUrl,
	size = "sm",
	primary = "machine",
	meta,
	titleAdornment,
	className,
}: {
	name?: string | null | undefined;
	machineName: string | null | undefined;
	displayName?: string | null | undefined;
	defaultName?: string | null | undefined;
	type: string | null | undefined;
	avatarUrl?: string | null | undefined;
	size?: AgentIconSize;
	/** Which field is the H1 line. Defaults to "machine": display
	 * override, default Agent name, API name alias, machine metadata, then runtime. */
	primary?: "type" | "machine";
	/** Inline meta items rendered in the subtitle row after the
	 * primary disambiguator (e.g. last-seen, DaemonStatusBadge).
	 * Falsy entries are filtered. The whole row uses flex-wrap +
	 * per-segment whitespace-nowrap so wrap breaks at segment
	 * boundaries — no orphaned `·` separators or mid-word cuts. */
	meta?: ReactNode[];
	/** Tag rendered immediately to the right of the title — for
	 * identity-level adornments that aren't meta-data (e.g. a
	 * source badge). Goes here, not in meta, so it stays
	 * with the name as a single visual unit no matter how the
	 * subtitle wraps. */
	titleAdornment?: ReactNode;
	className?: string;
}) {
	const typeLabel = agentTypeLabel(type);
	const identity = agentIdentity({
		name,
		display_name: displayName,
		default_name: defaultName,
		machine_name: machineName,
		agent_type: type,
	});
	const cleanedMachine = cleanMachineName(machineName);
	const rawTitleText = primary === "type" ? typeLabel : identity.primaryLabel;
	const titleText = rawTitleText;
	// The disambiguator is the OTHER field — when title is the type
	// we surface the machine name (and vice versa). Suppressed if
	// it'd duplicate the title (e.g. hosted tiles whose
	// `machineName` is just the runtime label "Hermes" — disambig
	// would print "Hermes" again under the title).
	const rawDisambig = primary === "type" ? cleanedMachine : identity.secondaryLabel;
	const disambiguator = rawDisambig && rawDisambig !== titleText ? rawDisambig : null;

	const filteredMeta = (meta ?? []).filter((m) => m !== null && m !== undefined && m !== false);
	const subtitleSegments: ReactNode[] = [];
	if (disambiguator) subtitleSegments.push(disambiguator);
	for (const m of filteredMeta) subtitleSegments.push(m);

	return (
		<div className={cn("flex min-w-0 items-center gap-3", className)}>
			<AgentIcon agent={type} size={size} avatarUrl={avatarUrl} />
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
