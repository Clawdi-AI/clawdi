import { AGENT_FILES } from "@/lib/agent-files";

export function llmsTxt(publicOrigin: string, instanceOrigin: string): string {
	return `# Clawdi
> The best home for all your AI agents. Run them in the cloud or connect your own, with their context and tools in one place.

## Agents
- [Get started](${publicOrigin}${AGENT_FILES.getStarted.path}): Follow this guide to connect your machine and sync your agents.
- [Clawdi skill](${publicOrigin}${AGENT_FILES.skill.path}): The bundled Agent Skill, installed by clawdi setup for supported agents.
- [Skill discovery index](${publicOrigin}${AGENT_FILES.discoveryIndex.path}): Agent Skills Discovery RFC v0.2.0 metadata and integrity digest.
- [CLI installer](https://clawdi.ai/install.sh): Install the Clawdi CLI on macOS or Linux.

## Documentation
- [Documentation index](https://docs.clawdi.ai/llms.txt): Discover the full product documentation.
- [Connected Agent quickstart](https://docs.clawdi.ai/getting-started/quickstart): Set up and connect your own agents.

## Product
- [Dashboard](${instanceOrigin}/): Manage your agents, sessions, memory, skills, and vaults.
- [Pricing](https://clawdi.ai/pricing): Cloud plans and pricing.

## Open source
- [GitHub](https://github.com/Clawdi-AI/clawdi): Source code, issues, and contributions.
- [AGENTS.md](https://github.com/Clawdi-AI/clawdi/blob/main/AGENTS.md): Contributor setup and verification commands.
`;
}
