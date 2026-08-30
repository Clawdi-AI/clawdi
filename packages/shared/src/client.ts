export type ClientPlatform = "web" | "desktop" | "mobile";

export type ClientCapabilitySupport =
	| "direct"
	| "adapted"
	| "handoff"
	| "unsupported"
	| "policy-gated";

export type PlatformCapabilities = {
	cloudData: ClientCapabilitySupport;
	localAgentSetup: ClientCapabilitySupport;
	localAgentInventory: ClientCapabilitySupport;
	connectedAgentDisconnect: ClientCapabilitySupport;
	backgroundLocalSync: ClientCapabilitySupport;
	hostedAgentLifecycle: ClientCapabilitySupport;
	hostedTerminal: ClientCapabilitySupport;
	billing: ClientCapabilitySupport;
	pushNotifications: ClientCapabilitySupport;
};

/** Product entitlements are separate; this table describes client support only. */
export const PLATFORM_CAPABILITIES = {
	web: {
		cloudData: "direct",
		localAgentSetup: "handoff",
		localAgentInventory: "unsupported",
		connectedAgentDisconnect: "direct",
		backgroundLocalSync: "handoff",
		hostedAgentLifecycle: "direct",
		hostedTerminal: "direct",
		billing: "direct",
		pushNotifications: "adapted",
	},
	desktop: {
		cloudData: "direct",
		localAgentSetup: "direct",
		localAgentInventory: "direct",
		connectedAgentDisconnect: "direct",
		backgroundLocalSync: "direct",
		hostedAgentLifecycle: "direct",
		hostedTerminal: "direct",
		billing: "direct",
		pushNotifications: "adapted",
	},
	mobile: {
		cloudData: "direct",
		localAgentSetup: "unsupported",
		localAgentInventory: "unsupported",
		connectedAgentDisconnect: "unsupported",
		backgroundLocalSync: "unsupported",
		hostedAgentLifecycle: "direct",
		hostedTerminal: "adapted",
		billing: "policy-gated",
		pushNotifications: "direct",
	},
} as const satisfies Record<ClientPlatform, PlatformCapabilities>;

export type AgentOwnershipKind = "cloud" | "legacy" | "connected" | "unresolved";

export type AgentOwnership = {
	/** Externally managed Agent ids, normalized to lowercase. */
	cloudAgentIds: ReadonlySet<string>;
	legacyAgentIds: ReadonlySet<string>;
	/** False keeps ids absent from both known sets unresolved. */
	isResolved: boolean;
};

const EMPTY_AGENT_ID_SET: ReadonlySet<string> = new Set();

/** Resolved ownership for clients without an external control plane. */
export const EMPTY_AGENT_OWNERSHIP: AgentOwnership = {
	cloudAgentIds: EMPTY_AGENT_ID_SET,
	legacyAgentIds: EMPTY_AGENT_ID_SET,
	isResolved: true,
};

export function normalizeAgentId(id: string | null | undefined): string | null {
	const normalized = id?.trim().toLowerCase();
	return normalized ? normalized : null;
}

export function agentOwnershipKindFromId(
	agentId: string | null | undefined,
	ownership: AgentOwnership | null,
): AgentOwnershipKind {
	const normalized = normalizeAgentId(agentId);
	if (!ownership) return "unresolved";
	if (!normalized) return ownership.isResolved ? "connected" : "unresolved";
	if (ownership.cloudAgentIds.has(normalized)) return "cloud";
	if (ownership.legacyAgentIds.has(normalized)) return "legacy";
	return ownership.isResolved ? "connected" : "unresolved";
}

export type AgentActionEligibility =
	| { eligible: true }
	| {
			eligible: false;
			reason:
				| "platform_unsupported"
				| "explicit_identity"
				| "ownership_unresolved"
				| "externally_managed";
	  };

export function agentDisconnectEligibility({
	platform,
	agentId,
	explicitIdentity,
	ownership,
}: {
	platform: ClientPlatform;
	agentId: string | null | undefined;
	explicitIdentity?: boolean | null;
	ownership: AgentOwnership | null;
}): AgentActionEligibility {
	if (PLATFORM_CAPABILITIES[platform].connectedAgentDisconnect !== "direct") {
		return { eligible: false, reason: "platform_unsupported" };
	}
	if (explicitIdentity === true) {
		return { eligible: false, reason: "explicit_identity" };
	}

	const ownershipKind = agentOwnershipKindFromId(agentId, ownership);
	if (ownershipKind === "unresolved") {
		return { eligible: false, reason: "ownership_unresolved" };
	}
	if (ownershipKind !== "connected") {
		return { eligible: false, reason: "externally_managed" };
	}
	return { eligible: true };
}
