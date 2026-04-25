import { AgentIcon } from "@/components/dashboard/agent-icon";
import { cn } from "@/lib/utils";

/**
 * Canonical display for an Agent across the app.
 *
 * Hierarchy: machine_name is the PRIMARY label (what the user sees on
 * their own machine), agent_type is the secondary muted context. Used in
 * Sessions table, Overview card, Agent detail header, Cmd+K results — so
 * the same agent reads the same everywhere.
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

type Size = "sm" | "md" | "lg";

const ICON_SIZE: Record<Size, string> = {
	sm: "size-6 rounded",
	md: "size-8 rounded-md",
	lg: "size-12 rounded-md",
};

const NAME_CLASS: Record<Size, string> = {
	sm: "text-sm font-medium",
	md: "text-sm font-medium",
	lg: "text-xl font-semibold",
};

export function AgentLabel({
	machineName,
	type,
	size = "sm",
	className,
}: {
	machineName: string | null | undefined;
	type: string | null | undefined;
	size?: Size;
	className?: string;
}) {
	const name = machineName || agentTypeLabel(type);
	const showType = Boolean(machineName && type);

	return (
		<div className={cn("flex min-w-0 items-center gap-2", className)}>
			<AgentIcon agent={type} className={ICON_SIZE[size]} />
			<div className="min-w-0">
				<div className={cn("truncate", NAME_CLASS[size])}>{name}</div>
				{showType ? (
					<div className="truncate text-xs text-muted-foreground">{agentTypeLabel(type)}</div>
				) : null}
			</div>
		</div>
	);
}
