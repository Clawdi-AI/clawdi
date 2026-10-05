import { type SessionAgentIdentity, sessionAgentIdentityInput } from "@clawdi/shared/view";
import type { AgentIconSize } from "@/components/dashboard/agent-icon";
import { AgentLabel } from "@/components/dashboard/agent-label";

export function SessionAgentLabel({
	session,
	size = "sm",
	className,
}: {
	session: SessionAgentIdentity;
	size?: AgentIconSize;
	className?: string;
}) {
	const identity = sessionAgentIdentityInput(session);
	return (
		<AgentLabel
			name={identity.name}
			displayName={identity.display_name}
			defaultName={identity.default_name}
			machineName={identity.machine_name}
			type={identity.agent_type}
			size={size}
			className={className}
		/>
	);
}
