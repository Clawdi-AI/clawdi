import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const onboardingSource = readFileSync(new URL("./onboarding-card.tsx", import.meta.url), "utf8");
const setupSource = readFileSync(new URL("./add-agent-setup.tsx", import.meta.url), "utf8");
const dialogSource = readFileSync(new URL("./add-agent-dialog.tsx", import.meta.url), "utf8");
const newAgentSource = readFileSync(new URL("./new-agent-button.tsx", import.meta.url), "utf8");
const publicSkillSource = readFileSync(
	new URL("../../../public/skill.md", import.meta.url),
	"utf8",
);
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
		expect(onboardingSource).toContain("Deploy another Agent on Clawdi");
		expect(onboardingSource).toContain("Connect an Agent on your machine");
		expect(onboardingSource).toContain("<AddAgentDialog");
		expect(onboardingSource).toContain("onClick={connectAgent}");
		expect(onboardingSource).toContain("desktopBridge.openConnectWizard()");
		expect(onboardingSource).not.toContain("AddAgentSetup");
		expect(dialogSource).toContain("<AddAgentSetup />");
		expect(newAgentSource).toContain("<AddAgentDialog");
		expect(dashboardSource).toContain("<AddAgentDialog");
		expect(newAgentSource).toContain("desktopBridge.openConnectWizard()");
		expect(dashboardSource).toContain("desktopBridge.openConnectWizard()");
		expect(onboardingSource).not.toContain("showHostedFirstAgentChoice");
		expect(onboardingSource).not.toContain("Deploy a hosted agent");
	});

	test("keeps the sidebar chooser terminology and capability gate consistent", () => {
		expect(newAgentSource).toContain(
			"const canDeployOnClawdi = hydrated && IS_HOSTED && hostedAccess.canCreateCloudAgents;",
		);
		expect(newAgentSource).toContain("{canDeployOnClawdi ? (");
		expect(newAgentSource).toContain(
			'title={checkingDeployAccess ? "Checking access" : "Deploy on Clawdi"}',
		);
		expect(newAgentSource).toContain('title="Connect an Agent on your machine"');
		expect(newAgentSource).not.toContain("Connect your own agent");
		expect(newAgentSource).not.toContain("Deploy managed agent");
	});
});

describe("connected-agent setup paths", () => {
	test("lists every CLI-connected agent without implying hosted deployment support", () => {
		expect(setupSource).toContain("Detects Claude Code, Codex, Hermes, OpenClaw, Pi, and OpenCode");
		expect(setupSource).toContain(
			"Paste this prompt into Claude Code, Codex, Hermes, OpenClaw, Pi, or OpenCode",
		);
		expect(dialogSource).toContain(
			"Connect an Agent on your machine — Claude Code, Codex, Hermes, OpenClaw, Pi, or",
		);
		expect(dialogSource).toContain("OpenCode.");
		expect(newAgentSource).toContain(
			"Claude Code, Codex, Hermes, OpenClaw, Pi, or OpenCode via the CLI.",
		);
		expect(publicSkillSource).toContain("Claude Code, Codex, Hermes, OpenClaw, Pi, and OpenCode");
		expect(publicSkillSource).toContain(
			"Pi and OpenCode sync Sessions only; neither receives Skill or MCP installation.",
		);
	});

	test("defaults to sequential npm commands with per-step copy controls", () => {
		expect(setupSource).toContain('<Tabs defaultValue="commands">');
		expect(setupSource).toContain('<TabsTrigger value="commands">');
		expect(setupSource).toContain("Run commands");
		for (const command of ["npm install -g clawdi@latest", "clawdi auth login", "clawdi setup"]) {
			expect(setupSource).toContain(`code: "${command}"`);
		}
		expect(setupSource).toContain("<CopyButton text={step.code} label={`Copy ");
		expect(setupSource).toContain("command`} />");
		expect(setupSource).not.toContain("ONE_COMMAND");
		expect(setupSource).not.toContain(
			"npm install -g clawdi@latest && clawdi auth login && clawdi setup",
		);
		expect(setupSource).not.toContain("One command");
		expect(setupSource).not.toContain("npx ");
	});

	test("keeps the agent prompt as a peer tab with its own copy action", () => {
		expect(setupSource).toContain('<TabsTrigger value="prompt">');
		expect(setupSource).toContain("Ask your agent");
		expect(setupSource).toContain('<TabsContent value="prompt"');
		expect(setupSource).toContain('label="Copy prompt"');
		expect(setupSource).not.toContain("<Disclosure");
	});

	test("states the Node requirement and keeps Bun as a secondary alternative", () => {
		expect(setupSource).toContain("Node.js 24+ is required.");
		expect(setupSource).toContain("Prefer Bun? Use: bun add -g clawdi@latest");
	});
});
