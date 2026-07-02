"use client";

import { createContext, createElement, type ReactNode, useContext } from "react";

export type AgentOwnershipKind = "cloud" | "legacy" | "connected";

export type AgentOwnership = {
	/**
	 * Environment ids managed by an external control plane.
	 *
	 * A `null` context strictly means "still resolving": the provider is
	 * expecting ownership data that has not arrived yet. Cosmetic consumers
	 * (badges, labels, section chrome) may fall back to "connected" while
	 * resolving, but DESTRUCTIVE actions (Disconnect) must wait for a
	 * non-null value. When no external control plane applies (OSS builds,
	 * hosted users without hosted capabilities) the provider supplies
	 * `EMPTY_AGENT_OWNERSHIP` — resolved, everything connected — so those
	 * surfaces never wait.
	 */
	cloudEnvIds: ReadonlySet<string>;
	legacyEnvIds: ReadonlySet<string>;
};

const EMPTY_ENV_ID_SET: ReadonlySet<string> = new Set();

/** Resolved "no external control plane" value — see the type docs. */
export const EMPTY_AGENT_OWNERSHIP: AgentOwnership = {
	cloudEnvIds: EMPTY_ENV_ID_SET,
	legacyEnvIds: EMPTY_ENV_ID_SET,
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
