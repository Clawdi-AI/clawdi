import { type SessionAgentIdentity, sessionAgentIdentityInput } from "@clawdi/shared/view";
import type { AgentIconSize } from "@/components/dashboard/agent-icon";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { sessionProfileLabel } from "@/lib/agent-profiles";

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
