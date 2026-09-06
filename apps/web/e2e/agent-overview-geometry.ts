import { expect, type Page, type TestInfo } from "@playwright/test";

export async function expectAgentOverviewGeometry(
	page: Page,
	{ hosted, desktop }: { hosted: boolean; desktop: boolean },
) {
	const geometry = await page.locator("main").evaluate((main) => {
		const box = (selector: string, bordered = false) => {
			const element = main.querySelector(selector);
			if (!element) throw new Error(`Missing overview element: ${selector}`);
			if (bordered && getComputedStyle(element).borderTopWidth !== "1px") {
				throw new Error(`Expected an actual card border: ${selector}`);
			}
			return element.getBoundingClientRect().toJSON();
		};
		return {
			entry: box('[data-overview-section="entry"]'),
			activity: box('[data-overview-section="activity"]'),
			sessions: box('[data-testid="overview-session-grid"]'),
			status: box("[data-overview-status]", true),
			chat: main.querySelector('[data-overview-section="start-chat"]')
				? {
						section: box('[data-overview-section="start-chat"]'),
						web: box('[data-overview-module="dashboard"] [data-slot="button"]', true),
						channel: box('[data-overview-module="channels"]', true),
						provider: box('[data-overview-module="model-provider"]', true),
					}
				: null,
			resources: ["workspace", "shared"].map((id) => ({
				section: box(`[aria-labelledby="agent-overview-${id}"]`),
				cards: Array.from(
					main.querySelectorAll(`[aria-labelledby="agent-overview-${id}"] [data-overview-module]`),
				).map((card) =>
					box(`[data-overview-module="${card.getAttribute("data-overview-module")}"]`, true),
				),
			})),
			sessionCards: Array.from(main.querySelectorAll('[data-testid="session-card"] > a')).map(
				(card) => card.getBoundingClientRect().toJSON(),
			),
			overflows:
				main.scrollWidth > main.clientWidth + 1 ||
				document.documentElement.scrollWidth > window.innerWidth + 1,
		};
	});
	const aligned = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
	expect(geometry.overflows).toBe(false);
	if (hosted) {
		expect(geometry.activity.top).toBeGreaterThan(geometry.entry.bottom);
		aligned(geometry.activity.right, geometry.entry.right);
	} else if (desktop) {
		aligned(geometry.activity.top, geometry.entry.top);
		aligned(geometry.status.top, geometry.sessions.top);
		aligned(geometry.status.left - geometry.sessions.right, 16);
		aligned(geometry.status.right, geometry.entry.right);
		aligned(geometry.sessions.width, geometry.status.width * 2);
		if (geometry.sessionCards.length === 3)
			aligned(geometry.status.bottom, geometry.sessions.bottom);
	} else {
		expect(geometry.status.top).toBeGreaterThan(geometry.activity.bottom);
		aligned(geometry.status.left, geometry.entry.left);
		aligned(geometry.status.right, geometry.entry.right);
	}
	for (const { section } of geometry.resources) {
		aligned(section.left, geometry.entry.left);
		aligned(section.right, geometry.entry.right);
	}
	aligned(geometry.activity.left, geometry.entry.left);
	aligned(geometry.sessions.left, geometry.activity.left);
	aligned(geometry.sessions.right, geometry.activity.right);
	if (!desktop) aligned(geometry.activity.right, geometry.entry.right);
	expect(geometry.resources[0].section.top).toBeGreaterThan(
		Math.max(geometry.activity.bottom, geometry.status.bottom),
	);
	expect(geometry.resources[1].section.top).toBeGreaterThan(geometry.resources[0].section.bottom);
	for (const group of geometry.resources) {
		const columns = desktop ? 2 : 1;
		for (const [index, card] of group.cards.entries()) {
			aligned(card.width, group.cards[0].width);
			aligned(card.height, group.cards[0].height);
			if (index % columns === 0) aligned(card.left, group.section.left);
			else {
				aligned(card.top, group.cards[index - 1].top);
				aligned(card.left - group.cards[index - 1].right, 12);
				aligned(card.right, group.section.right);
			}
			if (index >= columns) aligned(card.top - group.cards[index - columns].bottom, 12);
			if (!desktop) aligned(card.right, group.section.right);
		}
	}
	for (const card of geometry.sessionCards) {
		aligned(card.left, geometry.sessions.left);
		aligned(card.right, geometry.sessions.right);
		if (desktop) expect(card.height).toBeLessThanOrEqual(72);
	}
	if (hosted) {
		const chat = geometry.chat;
		if (!chat) throw new Error("Missing Start Chat section");
		await expect(page.locator('[data-overview-section="start-chat"]')).toHaveCSS(
			"border-top-width",
			"0px",
		);
		expect(geometry.entry.top).toBeGreaterThan(chat.section.bottom);
		for (const [left, right] of [
			[chat.web, chat.channel],
			[chat.provider, geometry.status],
		]) {
			aligned(left.width, right.width);
			aligned(left.height, right.height);
			aligned(left.left, geometry.entry.left);
			aligned(right.right, geometry.entry.right);
			if (desktop) {
				aligned(left.top, right.top);
				aligned(right.left - left.right, 12);
			} else aligned(right.top - left.bottom, 12);
		}
		aligned(chat.web.left, chat.provider.left);
		aligned(chat.channel.right, geometry.status.right);
	} else expect(geometry.chat).toBeNull();
	return geometry;
}

export async function captureAgentOverview(page: Page, testInfo: TestInfo, name: string) {
	await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("Expected a fixed preview viewport");
	const scroller = page.locator("#dashboard-scroll-container");
	const overflow = await scroller.evaluate(
		(element) => element.scrollHeight - element.clientHeight,
	);
	// Desktop scrolls inside the dashboard; expose that content for the full-page deliverable.
	if (overflow > 0) {
		await page.setViewportSize({ width: viewport.width, height: viewport.height + overflow });
		await scroller.evaluate((element) => {
			element.scrollTop = 0;
		});
		await expect(page.locator('[aria-labelledby="agent-overview-shared"]')).toBeInViewport({
			ratio: 1,
		});
	}
	await page.screenshot({ path: testInfo.outputPath(`${name}-full.png`), fullPage: true });
	await page.setViewportSize(viewport);
	await page
		.locator("[data-agent-overview]")
		.screenshot({ path: testInfo.outputPath(`${name}-resources.png`) });
}
