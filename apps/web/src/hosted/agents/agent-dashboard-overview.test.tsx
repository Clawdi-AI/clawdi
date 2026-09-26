import { expect, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentDashboardOverview } from "@/hosted/agents/agent-dashboard-overview";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

function renderOverview(children: ReactNode) {
	const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
	return renderToStaticMarkup(
		<RouterContextProvider router={router}>{children}</RouterContextProvider>,
	);
}

test.each(["starting", "stopped", "failed", null, "running"] as const)(
	"keeps Dashboard visible and disabled without a usable runtime endpoint (%s)",
	(status) => {
		const deployment = hostedDeploymentFixture({ runtime: "hermes", status });
		const markup = renderOverview(
			<AgentDashboardOverview agentId={deployment.agent_id} deployment={deployment} />,
		);
		expect(markup).toContain("Hermes Dashboard");
		expect(markup).toContain("Chat on the web");
		expect(markup).not.toContain("Start Chat");
		expect(markup).not.toContain('role="status"');
		expect(markup).toContain('disabled=""');
		expect(markup).not.toContain("/console");
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
	const markup = renderOverview(
		<AgentDashboardOverview agentId={deployment.agent_id} deployment={deployment} />,
	);
	expect(markup).toContain("OpenClaw Control UI");
	expect(markup).not.toContain('role="status"');
	expect(markup).not.toContain("Temporarily unavailable");
	expect(markup).toContain('disabled=""');
	expect(markup).not.toContain("/console");
});

function advisoryDeployment(reason: "ProviderConflict" | "RuntimeUiUnavailable") {
	return hostedDeploymentFixture({
		runtime: "hermes",
		runtimeUiEndpoint: {
			runtime: "hermes",
			role: "control_ui",
			url: "https://runtime.example/",
			auth_mode: "oidc",
			browser_session_url:
				"https://api.example.test/v2/deployments/hdep_fixture/hermes-oidc/session",
			access_revision: 1,
			browser_mode: "embedded_and_top_level",
		},
		extraConditions: [
			{
				type: "Degraded",
				status: "True",
				reason,
				message: "Advisory",
				observedGeneration: 1,
				lastTransitionTime: "2026-01-01T00:00:00Z",
			},
		],
	});
}

test("a withdrawn dashboard is disabled with a short explanation while the agent keeps running", () => {
	const deployment = advisoryDeployment("RuntimeUiUnavailable");
	const markup = renderOverview(
		<AgentDashboardOverview agentId={deployment.agent_id} deployment={deployment} />,
	);
	expect(markup).toContain("Hermes Dashboard is unavailable. Your agent keeps running.");
	expect(markup).toContain('disabled=""');
	expect(markup).not.toContain("/console");
	expect(markup).not.toContain("Failed");
});

test("a provider conflict advisory keeps the dashboard available", () => {
	const deployment = advisoryDeployment("ProviderConflict");
	const markup = renderOverview(
		<AgentDashboardOverview agentId={deployment.agent_id} deployment={deployment} />,
	);
	expect(markup).not.toContain("unavailable");
	expect(markup).not.toContain('disabled=""');
	expect(markup).toContain("/console");
});
