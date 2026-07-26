import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeploymentStatusUnavailableState } from "@/hosted/deployment-status-unavailable";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";

test("renders an honest retryable state when deployment status is unavailable", () => {
	const deployment = hostedDeploymentFixture({ status: null });
	let markup = "";

	expect(() => {
		markup = renderToStaticMarkup(
			createElement(DeploymentStatusUnavailableState, {
				deployment,
				isRetrying: false,
				onRetry: () => undefined,
			}),
		);
	}).not.toThrow();

	expect(markup).toContain('data-testid="deployment-status-unavailable"');
	expect(markup).toContain("Deployment status unavailable");
	expect(markup).toContain("We can’t determine this agent’s deployment state right now.");
	expect(markup).toContain("Actions and live tools are paused");
	expect(markup).toContain("Check again");
	expect(markup).not.toContain(">Running<");
	expect(markup).not.toContain(">Failed<");
});
