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
		const subscriptionRow = main.querySelector("[data-overview-subscription-row]");
		const subscriptionStatus = subscriptionRow?.querySelector(
			"[data-overview-subscription-status]",
		);
		const subscriptionAction = subscriptionRow?.querySelector("[data-slot=button]");
		const subscriptionDate = subscriptionRow?.parentElement?.querySelector(":scope > dl");
		const entries = Array.from(
			main.querySelectorAll('[data-overview-section="tools"] [data-slot="card"]'),
		);
		const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		if (!context) throw new Error("Canvas is unavailable for color checks");
		const pixel = () => Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
		const paint = (color: string) => {
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
		};
		const luminance = (rgb: number[]) =>
			rgb
				.map((value) => {
					const channel = value / 255;
					return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
				})
				.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
		const colors = entries.map((card) => {
			const description = card.querySelector('[data-slot="card-description"]');
			if (!description) throw new Error("Missing entry description");
			paint(getComputedStyle(main).backgroundColor);
			paint(getComputedStyle(card).backgroundColor);
			const background = pixel();
			paint(getComputedStyle(description).color);
			const foreground = pixel();
			const levels = [luminance(background), luminance(foreground)];
			return { background, contrast: (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05) };
		});
		return {
			colors,
			subscription:
				subscriptionRow && subscriptionStatus
					? {
							row: subscriptionRow.getBoundingClientRect().toJSON(),
							status: subscriptionStatus.getBoundingClientRect().toJSON(),
							action: subscriptionAction?.getBoundingClientRect().toJSON() ?? null,
							date: subscriptionDate?.getBoundingClientRect().toJSON() ?? null,
						}
					: null,
			entry: box('[data-overview-section="entry"]'),
			activity: box('[data-overview-section="activity"]'),
			sessions: box('[data-testid="overview-session-grid"]'),
			status: box("[data-overview-status]", true),
			tools: main.querySelector('[data-overview-section="tools"]')
				? {
						section: box('[data-overview-section="tools"]'),
						web: box('[data-overview-module="dashboard"]', true),
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
	if (desktop) {
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
		expect(new Set(geometry.colors.map((color) => color.background.join(","))).size).toBe(3);
		for (const color of geometry.colors) expect(color.contrast).toBeGreaterThanOrEqual(4.5);
		if (geometry.subscription) {
			const { row, status, action, date } = geometry.subscription;
			if (action) {
				aligned(status.y + status.height / 2, action.y + action.height / 2);
				aligned(action.right, row.right);
				expect(action.left - status.right).toBeGreaterThanOrEqual(12);
			} else aligned(row.height, status.height);
			if (date) expect(date.top).toBeGreaterThan(row.bottom);
		}
		const tools = geometry.tools;
		if (!tools) throw new Error("Missing overview tools");
		await expect(page.getByRole("heading", { name: "Start Chat", exact: true })).toHaveCount(0);
		await expect(page.locator('[data-overview-section="tools"]')).toHaveCSS(
			"border-top-width",
			"0px",
		);
		expect(geometry.entry.top).toBeGreaterThan(tools.section.bottom);
		const cards = [tools.web, tools.channel, tools.provider];
		aligned(cards[0].left, geometry.entry.left);
		aligned(cards[2].right, geometry.entry.right);
		for (const [index, card] of cards.entries()) {
			aligned(card.width, cards[0].width);
			aligned(card.height, cards[0].height);
			if (desktop) {
				aligned(card.top, cards[0].top);
				aligned(card.height, geometry.resources[0].cards[0].height);
				if (index > 0) aligned(card.left - cards[index - 1].right, 12);
			} else {
				aligned(card.left, geometry.entry.left);
				aligned(card.right, geometry.entry.right);
				if (index > 0) aligned(card.top - cards[index - 1].bottom, 12);
			}
		}
	} else expect(geometry.tools).toBeNull();
	return geometry;
}

export async function captureAgentOverview(page: Page, testInfo: TestInfo, name: string) {
	await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0);
	await page.locator("#dashboard-scroll-container").evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.evaluate(() => window.scrollTo(0, 0));
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
