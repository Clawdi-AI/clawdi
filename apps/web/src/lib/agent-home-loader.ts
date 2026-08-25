const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";

export const loadHostedAgentHome = IS_HOSTED_BUILD
	? () => import("@/hosted/agents/agent-home")
	: null;

export const loadHostedAgentEventStreamLayout = IS_HOSTED_BUILD
	? () => import("@/hosted/agents/hosted-agent-event-stream-layout")
	: null;

export function preloadHostedAgentHome(): void {
	if (!loadHostedAgentHome) return;
	// A speculative chunk failure must not surface as an unhandled rejection.
	void loadHostedAgentHome().catch(() => undefined);
}
