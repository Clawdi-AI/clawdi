"use client";

import { createContext, type ReactNode, useContext } from "react";

const DeploymentEventStreamActiveContext = createContext(false);

export function DeploymentEventStreamActiveProvider({
	active,
	children,
}: {
	active: boolean;
	children: ReactNode;
}) {
	return (
		<DeploymentEventStreamActiveContext.Provider value={active}>
			{children}
		</DeploymentEventStreamActiveContext.Provider>
	);
}

export function useDeploymentEventStreamActive(): boolean {
	return useContext(DeploymentEventStreamActiveContext);
}
