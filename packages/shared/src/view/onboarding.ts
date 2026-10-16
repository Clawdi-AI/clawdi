export function onboardingCardModel(
	variant: "first-agent" | "additional-agent" = "first-agent",
	canDeployOnClawdi = false,
) {
	const isAdditionalAgent = variant === "additional-agent";
	const title = isAdditionalAgent
		? "Add another agent"
		: canDeployOnClawdi
			? "Get your first agent running"
			: "Let's connect your first agent";
	const description = isAdditionalAgent
		? canDeployOnClawdi
			? "Deploy a Cloud Agent, or connect an agent you already run."
			: "Connect another agent you run and manage it from this dashboard."
		: canDeployOnClawdi
			? "Deploy a Cloud Agent, or connect an agent you already run."
			: "Connect an agent you run and manage it from this dashboard.";
	return { isAdditionalAgent, title, description };
}

/** Web's sidebar "New agent" chooser; mobile opens it from the Agents header. */
export const newAgentChooserCopy = {
	title: "New agent",
	description: (canDeployOnClawdi: boolean) =>
		canDeployOnClawdi
			? "Deploy a Cloud Agent, or connect an agent you already run."
			: "Connect an agent you already run.",
	accessError: "Couldn't check Cloud Agent access",
	checkingAccess: "Checking access",
	deployTitle: "Deploy a Cloud Agent",
	deployDescription: "Clawdi runs and manages it — pick a framework and go live in minutes.",
	connectTitle: "Connect your own agent",
	connectDescription:
		"Claude Code, Codex, Hermes, OpenClaw, Pi, or OpenCode with Clawdi Desktop or the CLI.",
} as const;

/** The "Add an agent" connect flow opened from the chooser, onboarding and Overview. */
export const addAgentDialogCopy = {
	title: "Add an agent",
	description:
		"Connect an agent you run on your machine or server — Claude Code, Codex, Hermes, OpenClaw, Pi, or OpenCode.",
} as const;
