"use client";

import { createContext, createElement, type ReactNode, useContext } from "react";

export type AgentOwnershipKind = "cloud" | "legacy" | "connected";

export type AgentOwnership = {
	/**
	 * Environment ids managed by an external control plane.
	 *
	 * `null` context means ownership is unknown, unavailable, or still loading;
	 * callers should treat unknown environments as connected.
	 */
	cloudEnvIds: ReadonlySet<string>;
	legacyEnvIds: ReadonlySet<string>;
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
	if (!normalized || !ownership) return "connected";
	if (ownership.cloudEnvIds.has(normalized)) return "cloud";
	if (ownership.legacyEnvIds.has(normalized)) return "legacy";
	return "connected";
}
