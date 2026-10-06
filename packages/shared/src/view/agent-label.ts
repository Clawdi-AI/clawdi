const TYPE_LABEL: Record<string, string> = {
	"claude-code": "Claude Code",
	claude_code: "Claude Code",
	codex: "Codex",
	hermes: "Hermes",
	openclaw: "OpenClaw",
	opencode: "OpenCode",
	pi: "Pi",
	dsh: "DeepSeek Harness",
};

export function agentTypeLabel(type: string | null | undefined): string {
	if (!type) return "Unknown";
	return TYPE_LABEL[type] ?? type;
}

export type AgentSourceKind = "hosted" | "connected";

export type AgentIdentityInput = {
	name?: string | null;
	display_name?: string | null;
	default_name?: string | null;
	machine_name?: string | null;
	agent_type?: string | null;
};

export type AgentIdentity = {
	/** Canonical primary label for this agent in dashboard chrome. */
	primaryLabel: string;
	/** Runtime disambiguator when it is not already the primary label. */
	secondaryLabel: string | null;
};

export function agentIdentity(env: AgentIdentityInput): AgentIdentity {
	const customName = cleanAgentName(env.display_name) || null;
	const defaultName = cleanAgentName(env.default_name) || null;
	const apiName = cleanAgentName(env.name) || null;
	const machineName = cleanMachineName(env.machine_name) || null;
	const runtimeName = agentTypeLabel(env.agent_type);
	const primaryLabel = customName ?? defaultName ?? apiName ?? machineName ?? runtimeName;
	const secondaryLabel = runtimeName !== primaryLabel ? runtimeName : null;
	return {
		primaryLabel,
		secondaryLabel,
	};
}

export function agentDisplayName(env: AgentIdentityInput): string {
	return agentIdentity(env).primaryLabel;
}

export function cleanAgentName(value: string | null | undefined): string {
	return value?.trim() ?? "";
}

export function agentSourceKindLabel(source: AgentSourceKind): string {
	return source === "hosted" ? "Cloud Agent" : "Connected Agent";
}

export function agentSourceDescription(source: AgentSourceKind): string {
	return source === "hosted" ? "Runs on Clawdi" : "Runs from your machine or server";
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
