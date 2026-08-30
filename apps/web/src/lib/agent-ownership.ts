"use client";

import type { AgentOwnership } from "@clawdi/shared/client";
import { createContext, createElement, type ReactNode, useContext } from "react";

export {
	type AgentOwnership,
	type AgentOwnershipKind,
	agentOwnershipKindFromId,
	EMPTY_AGENT_OWNERSHIP,
	normalizeAgentId,
} from "@clawdi/shared/client";

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
