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
