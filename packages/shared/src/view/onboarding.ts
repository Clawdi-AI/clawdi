export function onboardingCardModel(
	variant: "first-agent" | "additional-agent" = "first-agent",
	canDeployOnClawdi = false,
) {
	const isAdditionalAgent = variant === "additional-agent";
	const title = isAdditionalAgent
		? "Add another Agent"
		: canDeployOnClawdi
			? "Get your first Agent running"
			: "Let's connect your first Agent";
	const description = isAdditionalAgent
		? canDeployOnClawdi
			? "Deploy another Agent on Clawdi, or connect one from your machine."
			: "Connect another Agent on your machine and manage it from this dashboard."
		: canDeployOnClawdi
			? "Deploy an Agent on Clawdi, or connect one from your machine."
			: "Connect an Agent on your machine and manage it from this dashboard.";
	return { isAdditionalAgent, title, description };
}
