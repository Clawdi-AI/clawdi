import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const onboardingSource = readFileSync(new URL("./onboarding-card.tsx", import.meta.url), "utf8");
const setupSource = readFileSync(new URL("./add-agent-setup.tsx", import.meta.url), "utf8");
const newAgentSource = readFileSync(new URL("./new-agent-button.tsx", import.meta.url), "utf8");
const hostedSectionSource = readFileSync(
	new URL("../../hosted/hosted-agents-section.tsx", import.meta.url),
	"utf8",
);
const dashboardSource = readFileSync(
	new URL("../../pages/dashboard/page.tsx", import.meta.url),
	"utf8",
);
const agentsIndexSource = readFileSync(
	new URL("../../pages/dashboard/agents/page.tsx", import.meta.url),
	"utf8",
);

describe("dashboard agent onboarding", () => {
	test("passes create access to both empty and returning hosted onboarding", () => {
		expect(dashboardSource).toContain(
			"const cloudDeploymentManagementEnabled = Boolean(HostedAgentsSection);",
		);
		expect(
			dashboardSource.match(/canDeployOnClawdi=\{hostedAccess\.canCreateCloudAgents\}/g),
		).toHaveLength(2);
		expect(
			dashboardSource.match(/showCloudDeployments=\{cloudDeploymentManagementEnabled\}/g),
		).toHaveLength(3);
		expect(agentsIndexSource).toContain("canDeployOnClawdi={hostedAccess.canCreateCloudAgents}");
		expect(agentsIndexSource).toContain("showCloudDeployments={cloudDeploymentManagementEnabled}");
		expect(hostedSectionSource).toContain(
			"<HostedEmptyAccountHero canDeployOnClawdi={canDeployOnClawdi} />",
		);
		expect(hostedSectionSource).toContain('variant="additional-agent"');
		expect(hostedSectionSource).toContain("canDeployOnClawdi={canDeployOnClawdi}");
	});

	test("uses one gated deploy-or-connect experience for first and additional agents", () => {
		expect(onboardingSource).toContain("{canDeployOnClawdi ? (");
		expect(onboardingSource).toContain("Deploy on Clawdi");
		expect(onboardingSource).toContain("Connect an agent on your machine");
		expect(onboardingSource).not.toContain("showHostedFirstAgentChoice");
		expect(onboardingSource).not.toContain("Deploy a hosted agent");
	});

	test("keeps the sidebar chooser terminology and capability gate consistent", () => {
		expect(newAgentSource).toContain(
			"const canDeployOnClawdi = hydrated && IS_HOSTED && hostedAccess.canCreateCloudAgents;",
		);
		expect(newAgentSource).toContain("{canDeployOnClawdi ? (");
		expect(newAgentSource).toContain(
			'title={checkingDeployAccess ? "Checking deploy access" : "Deploy on Clawdi"}',
		);
		expect(newAgentSource).toContain('title="Connect an agent on your machine"');
		expect(newAgentSource).not.toContain("Connect your own agent");
		expect(newAgentSource).not.toContain("Deploy managed agent");
	});
});

describe("connected-agent setup command", () => {
	test("defaults the displayed and copied command to npm", () => {
		const command = "npm install -g clawdi@latest && clawdi auth login && clawdi setup";
		expect(setupSource).toContain(`const ONE_COMMAND = "${command}";`);
		expect(setupSource).toContain("onClick={() => copy(ONE_COMMAND)}");
		expect(setupSource).toContain("{ONE_COMMAND}");
		expect(setupSource).not.toContain("npx ");
	});

	test("states the Node requirement and keeps Bun as a secondary alternative", () => {
		expect(setupSource).toContain("Node.js 22.5+ is required.");
		expect(setupSource).toContain("Prefer Bun? Use: bun add -g clawdi@latest");
	});
});
