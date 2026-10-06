import type { AgentIconSize } from "@/components/dashboard/agent-icon";
import { type AgentIdentityInput, AgentLabel } from "@/components/dashboard/agent-label";
import { sessionProfileLabel } from "@/lib/agent-profiles";

export type SessionAgentIdentity = {
	agent_name?: string | null;
	agent_display_name?: string | null;
	agent_default_name?: string | null;
	machine_name?: string | null;
	agent_type?: string | null;
	profile_key?: string | null;
	profile_display_name?: string | null;
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
	const profile = sessionProfileLabel(session);
	return (
		<AgentLabel
			name={identity.name}
			displayName={identity.display_name}
			defaultName={identity.default_name}
			machineName={identity.machine_name}
			type={identity.agent_type}
			size={size}
			titleAdornment={
				profile ? (
					<span className="block max-w-32 truncate text-sm text-muted-foreground" title={profile}>
						· {profile}
					</span>
				) : null
			}
			className={className}
		/>
	);
}
