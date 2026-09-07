import { expect, type Page, type TestInfo } from "@playwright/test";
import {
	computeNow,
	computeOverviewCases,
	computeRuntimeLabels,
} from "../src/hosted/agents/overview-compute.test-cases";
import type { HostedDeployment } from "../src/hosted/billing/contracts";
import { formatShortDate } from "../src/lib/format";
import { captureAgentOverview, expectAgentOverviewGeometry } from "./agent-overview-geometry";

/** Inspect actual text fragments, not just scrollWidth on an overflow-hidden ancestor. */
export async function expectComputeContentFits(page: Page) {
	const compute = page.locator('[data-overview-status="compute"]');
	const violations = await compute.evaluate((card) => {
		const bounds = card.getBoundingClientRect();
		const violations: string[] = [];
		const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent?.trim() || !node.parentElement) continue;
			const style = getComputedStyle(node.parentElement);
			if (
				style.visibility === "hidden" ||
				node.parentElement.closest('[aria-hidden="true"], .sr-only')
			)
				continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			for (const rect of range.getClientRects()) {
				if (
					rect.left < bounds.left ||
					rect.right > bounds.right ||
					rect.top < bounds.top ||
					rect.bottom > bounds.bottom
				)
					violations.push(`Text outside card: ${node.textContent}`);
			}
		}
		for (const row of card.querySelectorAll("dl > div")) {
			const label = row.querySelector("dt");
			const value = row.querySelector("dd");
			if (!label || !value) {
				violations.push("Incomplete fact row");
				continue;
			}
			if (
				!label.classList.contains("sr-only") &&
				label.getBoundingClientRect().right > value.getBoundingClientRect().left
			)
				violations.push("Label overlaps value");
			const action = value.querySelector("a");
			const status = value.querySelector("span");
			if (action && status) {
				const a = action.getBoundingClientRect();
				const s = status.getBoundingClientRect();
				if (a.left < s.right && s.left < a.right && a.top < s.bottom && s.top < a.bottom)
					violations.push("Action overlaps status");
				if (a.right > value.getBoundingClientRect().right + 1)
					violations.push("Action exceeds value track");
			}
		}
		if (card.querySelector("a a, a button, button a, button button"))
			violations.push("Nested interactive elements");
		return violations;
	});
	expect(violations).toEqual([]);
}

export async function runComputeOverviewMatrix(
	page: Page,
	testInfo: TestInfo,
	configure: (deployment: HostedDeployment) => Promise<void>,
) {
	await page.clock.setFixedTime(new Date(computeNow));
	const index = [];
	for (const { name, deployment, expected } of computeOverviewCases) {
		await configure(deployment);
		await page.goto(`/agents/${deployment.agent_id}`);
		const status = deployment.resource.status?.summary_state;
		const initial = status === "creating" || status === "starting";
		const removed = status === "deleting" || status === "deleted";
		const notFound = name === "deleted-no-projection";
		const compute = page.locator('[data-overview-status="compute"]');
		if (removed) {
			if (notFound) await expect(page.getByRole("alert")).toContainText("Agent not found");
			else await expect(page).toHaveURL("/");
			await expect(compute).toHaveCount(0);
			await expect(page.locator('[data-overview-status="status"]')).toHaveCount(0);
		} else if (initial) {
			await expect(page.getByTestId("hosted-initial-deployment-panel")).toBeVisible();
			await expect(compute).toHaveCount(0);
		} else {
			await expect(compute).toBeVisible();
			await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
			const summary = page.getByTestId("overview-compute-summary");
			expect((await summary.locator("dt").allTextContents()).slice(0, 3)).toEqual([
				"CPU",
				"Memory",
				"Storage",
			]);
			const value = summary.locator("[data-overview-subscription-status]");
			if (expected.status) await expect(value).toHaveText(expected.status);
			else await expect(value).toHaveCount(0);
			await expect(summary.locator("dl > div")).toHaveCount(
				3 + Number(expected.status !== null) + Number(Boolean(expected.date)),
			);
			if (expected.date) {
				await expect(summary.locator("dt").last()).toHaveText(expected.date[0]);
				await expect(summary.locator("dd").last()).toHaveText(formatShortDate(expected.date[1]));
			}
			const action = summary.locator('a[data-slot="button"]');
			await expect(action).toHaveCount(expected.action ? 1 : 0);
			if (expected.action) {
				const expectedHref =
					expected.action === "top_up"
						? `/agents/${deployment.agent_id}?settings=billing-wallet`
						: `/agents/${deployment.agent_id}/settings#compute-plan-controls`;
				await expect(action).toHaveAttribute("href", expectedHref);
				await expect(action).toHaveText(
					{ upgrade: "Upgrade", fix_payment: "Fix payment", top_up: "Top up", start_new: "Manage" }[
						expected.action
					],
				);
				await expect(
					page.locator('main [data-slot="alert"]').getByRole("button", {
						name: /^(Fix payment|Top up|Start a new subscription)$/,
					}),
				).toHaveCount(0);
			}
			if (expected.bannerRecovery)
				await expect(
					page.getByRole("button", { name: "Start a new subscription" }),
				).toHaveAttribute(
					"href",
					`/agents/${deployment.agent_id}/settings?settings=billing-plan&subscription_action=start_new`,
				);
			if (expected.transactions) {
				const href = await page
					.getByRole("button", { name: "View transactions" })
					.getAttribute("href");
				if (!href) throw new Error("Missing transaction recovery link");
				const url = new URL(href, page.url());
				expect(url.pathname.replace(/\/$/, "")).toBe(`/agents/${deployment.agent_id}`);
				expect(url.searchParams.get("settings")).toBe("billing-wallet");
				expect(url.hash).toBe("#transactions");
			}
			await expect(compute.locator("[data-overview-compute-status]")).toHaveText(
				name === "runtime-degraded"
					? "Temporarily unavailable"
					: status
						? computeRuntimeLabels[status]
						: "Status unavailable",
			);
		}
		for (const width of [1440, 320]) {
			await page.setViewportSize({ width, height: 1000 });
			await page.evaluate(() => document.fonts.ready);
			if (!initial && !removed) {
				await expectComputeContentFits(page);
				await expectAgentOverviewGeometry(page, { hosted: true, desktop: width === 1440 });
			}
			const filename = `${name}-${width}.png`;
			await (removed
				? page.locator("main")
				: initial
					? page.getByTestId("hosted-initial-deployment-panel")
					: compute
			).screenshot({ path: testInfo.outputPath(filename) });
			index.push({
				name,
				width,
				filename,
				expected,
				surface: notFound
					? "not-found"
					: removed
						? "dismissed"
						: initial
							? "initial-deployment"
							: "compute",
			});
			if (expected.bannerRecovery || expected.transactions)
				await captureAgentOverview(page, testInfo, `${name}-${width}-page`);
		}
	}
	await testInfo.attach("compute-state-index", {
		body: JSON.stringify(index, null, 2),
		contentType: "application/json",
	});
}
