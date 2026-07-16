"use client";

import { createContext, createElement, type ReactNode, useContext } from "react";

export type AgentOwnershipKind = "cloud" | "legacy" | "connected" | "unresolved";

export type AgentOwnership = {
	/**
	 * Environment ids managed by an external control plane.
	 *
	 * A `null` context means the hosted sensor has not reported yet. A partial
	 * last-known snapshot uses `isResolved: false`: ids already present in its
	 * sets retain their ownership, while every other id stays unresolved instead
	 * of being guessed as connected. Destructive actions follow the same rule.
	 * When no external control plane applies, the provider supplies
	 * `EMPTY_AGENT_OWNERSHIP` — resolved, everything connected.
	 */
	cloudEnvIds: ReadonlySet<string>;
	legacyEnvIds: ReadonlySet<string>;
	/** False keeps unknown ids unresolved while known ids retain their ownership. */
	isResolved: boolean;
};

const EMPTY_ENV_ID_SET: ReadonlySet<string> = new Set();

/** Resolved "no external control plane" value — see the type docs. */
export const EMPTY_AGENT_OWNERSHIP: AgentOwnership = {
	cloudEnvIds: EMPTY_ENV_ID_SET,
	legacyEnvIds: EMPTY_ENV_ID_SET,
	isResolved: true,
};

const AgentOwnershipContext = createContext<AgentOwnership | null>(null);

export function AgentOwnershipProvider({
	value,
	children,
}: {
	value: AgentOwnership | null;
	children: ReactNode;
}) {
	return createElement(AgentOwnershipContext.Provider, { value }, children);
}

export function useAgentOwnership(): AgentOwnership | null {
	return useContext(AgentOwnershipContext);
}

export function normalizeAgentEnvId(id: string | null | undefined): string | null {
	const normalized = id?.trim().toLowerCase();
	return normalized ? normalized : null;
}

export function agentOwnershipKindFromId(
	envId: string | null | undefined,
	ownership: AgentOwnership | null,
): AgentOwnershipKind {
	const normalized = normalizeAgentEnvId(envId);
	if (!ownership) return "unresolved";
	if (!normalized) return ownership.isResolved ? "connected" : "unresolved";
	if (ownership.cloudEnvIds.has(normalized)) return "cloud";
	if (ownership.legacyEnvIds.has(normalized)) return "legacy";
	return ownership.isResolved ? "connected" : "unresolved";
}

export function agentDisconnectUnavailable({
	envId,
	explicitIdentity,
	ownership,
}: {
	envId: string | null | undefined;
	explicitIdentity?: boolean | null;
	ownership: AgentOwnership | null;
}): boolean {
	return (
		explicitIdentity === true ||
		ownership === null ||
		agentOwnershipKindFromId(envId, ownership) !== "connected"
	);
}
