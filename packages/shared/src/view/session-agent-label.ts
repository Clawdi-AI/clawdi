import type { AgentIdentityInput } from "./agent-label";
export type SessionAgentIdentity = {
	agent_name?: string | null;
	agent_display_name?: string | null;
	agent_default_name?: string | null;
	machine_name?: string | null;
	agent_type?: string | null;
};

export function sessionAgentIdentityInput(session: SessionAgentIdentity): AgentIdentityInput {
	return {
		name: session.agent_name,
		display_name: session.agent_display_name,
		default_name: session.agent_default_name,
		machine_name: session.machine_name,
		agent_type: session.agent_type,
	};
}
