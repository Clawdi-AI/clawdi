import { AGENT_FILES } from "@/lib/agent-files";

// Single source for the dashboard and marketing; served at /agent-setup-prompt.txt.
export function agentSetupPrompt(origin: string): string {
	const guideUrl = `${origin}${AGENT_FILES.getStarted.path}`;
	return `Set up Clawdi on this machine. Read all of ${guideUrl} (for example, run \`curl -fsSL ${guideUrl}\`) and follow its steps in order.`;
}
