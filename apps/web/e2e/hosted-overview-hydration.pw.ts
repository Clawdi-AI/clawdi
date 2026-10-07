import { expect, test } from "@playwright/test";
import {
	basicPlan,
	collectBrowserErrors,
	fixtureAgentId,
	includedBasicDeployment,
	stubHostedApi,
} from "./hosted-stub-api";

const HYDRATION_ERROR = /Hydration failed|Minified React error #418/;

// The ownership sensor fills the deployments cache once the dashboard shell
// hydrates, often before the lazy agent boundary does. The boundary's
// hydration render must still match the server skeleton.
for (const { label, path, ready } of [
	{ label: "overview", path: "", ready: "Compute" },
	{ label: "settings", path: "/settings", ready: "Basic plan" },
]) {
	test(`hosted agent ${label} cold load hydrates without a mismatch`, async ({ page }) => {
		const errors = collectBrowserErrors(page);
		await stubHostedApi(page, { deployments: [includedBasicDeployment], plans: [basicPlan] });

		await page.goto(`/agents/${fixtureAgentId(includedBasicDeployment)}${path}`);
		await expect(page.getByText(ready, { exact: true }).first()).toBeVisible();
		await expect(page.locator("[data-agent-detail-skeleton]")).toHaveCount(0);
		// A mismatch is reported while the boundary hydrates; one more frame flushes it.
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));

		const hydrationErrors = errors.filter((error) => HYDRATION_ERROR.test(error));
		expect(hydrationErrors, hydrationErrors.join(" | ")).toEqual([]);
	});
}
