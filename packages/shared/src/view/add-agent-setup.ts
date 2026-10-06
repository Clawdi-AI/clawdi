// Tests keep these install steps in sync with the READMEs and get-started.md.
export const CLI_STEPS = [
	{
		title: "Install the CLI",
		code: "curl -fsSL https://clawdi.ai/install.sh | sh",
		description: "Install the latest Clawdi CLI without Node.js or sudo.",
	},
	{
		title: "Sign in",
		code: "clawdi auth login",
		description: "Complete browser authorization before continuing to the next step.",
	},
	{
		title: "Connect and enable sync",
		code: "clawdi setup",
		description:
			"Detects Claude Code, Codex, Hermes, OpenClaw, Pi, and OpenCode; connects each one to your account and enables background sync.",
	},
	{
		title: "Verify setup",
		code: "clawdi doctor",
		description: "Check that Clawdi is ready on this machine.",
	},
];

export const INSTALLATION_DOCS_URL = "https://docs.clawdi.ai/installation";

/** Origin of the hosted marketing site that publishes the agent-facing files. */
export const HOSTED_PUBLIC_SITE_ORIGIN = "https://clawdi.ai";

/** Path of the published onboarding guide (Web `AGENT_FILES.getStarted`). */
const GET_STARTED_PATH = "/get-started.md";

// Single source for the dashboard's pointer to the onboarding guide.
export function agentSetupPrompt(origin: string): string {
	const guideUrl = `${origin}${GET_STARTED_PATH}`;
	return `Set up Clawdi on this machine. Read all of ${guideUrl} (for example, run \`curl -fsSL ${guideUrl}\`) and follow its steps in order.`;
}
