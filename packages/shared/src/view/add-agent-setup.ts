export const CLI_STEPS = [
	{
		title: "Install the CLI",
		code: "npm install -g clawdi@latest",
		description: "Install the latest Clawdi CLI globally.",
	},
	{
		title: "Log in",
		code: "clawdi auth login",
		description: "Complete browser authorization before continuing to the next step.",
	},
	{
		title: "Connect and enable sync",
		code: "clawdi setup",
		description:
			"Detects Claude Code, Codex, Hermes, OpenClaw, Pi, and OpenCode; connects each one to your account and enables background sync.",
	},
];

export function agentSetupPrompt(origin: string): string {
	return `Set up Clawdi on this machine. Fetch ${origin}/skill.md, and follow the skills to set it up. Finally, confirm the installation with \`clawdi doctor\`.`;
}
