import { Cloud, History, Laptop } from "lucide-react";
import type { ReactNode } from "react";
import { AgentIcon, type AgentIconSize } from "@/components/dashboard/agent-icon";
import {
	type AgentOwnershipKind,
	agentOwnershipKindFromId,
	useAgentOwnership,
} from "@/lib/agent-ownership";
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
 *     [icon] Research Agent
 *            Hermes · meta…
 *     The identity label is the H1: display override, default Agent
 *     name, machine metadata, then runtime fallback. agent_type drops
 *     to the subtitle where it disambiguates similar names.
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

export type AgentSourceKind = "hosted" | "connected";

function sourceFromOwnershipKind(kind: AgentOwnershipKind): AgentSourceKind {
	return kind === "cloud" ? "hosted" : "connected";
}

export type AgentIdentityInput = {
	name?: string | null;
	display_name?: string | null;
	default_name?: string | null;
	machine_name?: string | null;
	agent_type?: string | null;
};

export type AgentIdentity = {
	customName: string | null;
	defaultName: string | null;
	machineName: string | null;
	runtimeName: string;
	primaryLabel: string;
	secondaryLabel: string | null;
};

export function agentIdentity(env: AgentIdentityInput): AgentIdentity {
	const customName = cleanMachineName(env.display_name) || null;
	const defaultName = cleanMachineName(env.default_name) || cleanMachineName(env.name) || null;
	const machineName = cleanMachineName(env.machine_name) || null;
	const runtimeName = agentTypeLabel(env.agent_type);
	const primaryLabel = customName ?? defaultName ?? machineName ?? runtimeName;
	const secondaryLabel = runtimeName !== primaryLabel ? runtimeName : null;
	return {
		customName,
		defaultName,
		machineName,
		runtimeName,
		primaryLabel,
		secondaryLabel,
	};
}

export function agentDisplayName(
	env: AgentIdentityInput,
	_options: { ownershipKind?: AgentOwnershipKind } = {},
): string {
	return agentIdentity(env).primaryLabel;
}

export function agentSourceLabel(source: AgentSourceKind): string {
	return source === "hosted" ? "Cloud" : "Your machine";
}

export function agentSourceKindLabel(source: AgentSourceKind): string {
	return source === "hosted" ? "Clawdi Cloud agent" : "Your machine agent";
}

export function agentSourceDescription(source: AgentSourceKind): string {
	return source === "hosted"
		? "Deployed and managed by Clawdi Cloud"
		: "Runs from your machine or server";
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
	const iconClass =
		source === "hosted" ? "text-sky-600 dark:text-sky-300" : "text-muted-foreground";
	return (
		<span
			title={title}
			className={cn(
				"inline-flex shrink-0 items-center whitespace-nowrap border font-medium leading-none shadow-sm",
				iconOnly
					? "size-4 justify-center rounded-full p-0"
					: compact
						? "h-5 gap-1 rounded-full px-1.5 text-[11px]"
						: "h-5 gap-1.5 rounded-full px-2 text-[11px]",
				source === "hosted"
					? "border-sky-200 bg-background text-foreground dark:border-sky-500/35 dark:bg-background/80"
					: "border-border bg-background text-muted-foreground",
				className,
			)}
		>
			<Icon className={cn(iconOnly ? "size-2.5" : "size-3.5", iconClass)} />
			{iconOnly ? <span className="sr-only">{label}</span> : label}
		</span>
	);
}

export function LegacyAgentBadge({
	compact = false,
	className,
}: {
	compact?: boolean;
	className?: string;
}) {
	return (
		<span
			title="Managed in the legacy hosted dashboard"
			className={cn(
				"inline-flex shrink-0 items-center whitespace-nowrap border border-amber-200 bg-background font-medium leading-none text-foreground shadow-sm dark:border-amber-500/35 dark:bg-background/80",
				compact
					? "h-5 gap-1 rounded-full px-1.5 text-[11px]"
					: "h-5 gap-1.5 rounded-full px-2 text-[11px]",
				className,
			)}
		>
			<History className="size-3.5 text-amber-600 dark:text-amber-300" />
			Legacy
		</span>
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
	if (kind === "legacy") {
		if (iconOnly) return null;
		return <LegacyAgentBadge compact={compact} className={className} />;
	}
	const source = sourceFromOwnershipKind(kind);
	if (source === "connected" && !showConnected) return null;
	return (
		<AgentSourceBadge source={source} compact={compact} iconOnly={iconOnly} className={className} />
	);
}

export function agentTextLabel(
	env: AgentIdentityInput & { id?: string | null },
	{
		includeSource = true,
		ownershipKind = "connected",
	}: { includeSource?: boolean; ownershipKind?: AgentOwnershipKind } = {},
): string {
	const identity = agentIdentity(env);
	const source = sourceFromOwnershipKind(ownershipKind);
	const parts = [
		includeSource && source === "hosted" ? agentSourceLabel(source) : null,
		identity.primaryLabel,
		identity.secondaryLabel,
	].filter((part): part is string => Boolean(part));
	return parts.join(" · ");
}

export function compareAgentEnvironments(
	a: {
		id?: string | null;
		name?: string | null;
		display_name?: string | null;
		default_name?: string | null;
		machine_name?: string | null;
		agent_type?: string | null;
		sort_order?: number | null;
	},
	b: {
		id?: string | null;
		name?: string | null;
		display_name?: string | null;
		default_name?: string | null;
		machine_name?: string | null;
		agent_type?: string | null;
		sort_order?: number | null;
	},
): number {
	const aOrder = a.sort_order ?? Number.MAX_SAFE_INTEGER;
	const bOrder = b.sort_order ?? Number.MAX_SAFE_INTEGER;
	if (aOrder !== bOrder) return aOrder - bOrder;

	const aName = agentDisplayName(a);
	const bName = agentDisplayName(b);
	const name = aName.localeCompare(bName);
	if (name !== 0) return name;

	const type = agentTypeLabel(a.agent_type).localeCompare(agentTypeLabel(b.agent_type));
	if (type !== 0) return type;
	return (a.id ?? "").localeCompare(b.id ?? "");
}

/** Strip mDNS-style suffixes (`.local`, `.lan`) from a hostname.
 * Bonjour appends `.local` automatically on macOS — the user
 * never typed it, never thinks about it, and showing it just
 * eats column width without conveying any information. */
export function cleanMachineName(raw: string | null | undefined): string {
	if (!raw) return "";
	const cleaned = raw.replace(/\.(local|lan)$/i, "").trim();
	return cleaned;
}

/** Middle-truncate generated deployment names for display. A fleet of
 * `openclaw-164ec696-744994f657-mgc9m` tiles is unreadable, and
 * END-truncation (`truncate`) cuts the final group — the only part
 * that distinguishes two clones. Keep runtime prefix + last group:
 * `openclaw…mgc9m`. Human-chosen names pass through untouched; the
 * full name stays available via the title tooltip. */
export function displayMachineName(name: string): string {
	const m = name.match(/^([a-z][a-z0-9_]*)-(?:[0-9a-f]{6,}-)+([a-z0-9]{4,12})$/i);
	if (!m) return name;
	return `${m[1]}…${m[2]}`;
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
	machineName: string | null | undefined;
	displayName?: string | null | undefined;
	defaultName?: string | null | undefined;
	type: string | null | undefined;
	avatarUrl?: string | null | undefined;
	size?: AgentIconSize;
	/** Which field is the H1 line. Defaults to "machine": display
	 * override, then default Agent name, then machine metadata, then runtime. */
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
		display_name: displayName,
		default_name: defaultName,
		machine_name: machineName,
		agent_type: type,
	});
	const cleanedMachine = cleanMachineName(machineName);
	const titleText = primary === "type" ? typeLabel : identity.primaryLabel;
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
						{displayMachineName(titleText)}
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
