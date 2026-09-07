const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

export const loadHostedAgentHome = IS_HOSTED_BUILD
	? () => import("@/hosted/agents/agent-home")
	: null;
