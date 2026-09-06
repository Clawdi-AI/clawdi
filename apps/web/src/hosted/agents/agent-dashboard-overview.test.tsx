import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentDashboardOverview } from "@/hosted/agents/agent-dashboard-overview";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

test.each(["starting", "stopped", "failed", null, "running"] as const)(
	"keeps Dashboard visible and disabled without a usable runtime endpoint (%s)",
	(status) => {
		const deployment = hostedDeploymentFixture({ runtime: "hermes", status });
		const markup = renderToStaticMarkup(
			<AgentDashboardOverview agentId={deployment.agent_id} deployment={deployment} />,
		);
		expect(markup).toContain("Hermes Dashboard");
		expect(markup).toContain("Open Dashboard");
		expect(markup).toContain('disabled=""');
		expect(markup).not.toContain("href=");
	},
);

test("current runtime degradation disables a retained endpoint", () => {
	const deployment = hostedDeploymentFixture({
		runtimeUiEndpoint: {
			runtime: "openclaw",
			role: "control_ui",
			url: "https://runtime.example/",
			auth_mode: "openclaw_token",
			browser_mode: "embedded_and_top_level",
		},
	});
	if (!deployment.resource.status) throw new Error("Fixture must have a status");
	deployment.resource.status.conditions.push({
		type: "Degraded",
		status: "True",
		reason: "RuntimeHealthDegraded",
		message: "Runtime temporarily unavailable",
		observedGeneration: 1,
		lastTransitionTime: "2026-01-01T00:00:00Z",
	});
	const markup = renderToStaticMarkup(
		<AgentDashboardOverview agentId={deployment.agent_id} deployment={deployment} />,
	);
	expect(markup).toContain("OpenClaw Control UI");
	expect(markup).toContain("Temporarily unavailable");
	expect(markup).toContain('disabled=""');
	expect(markup).not.toContain("href=");
});
