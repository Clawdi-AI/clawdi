import { expect, type Page, type TestInfo } from "@playwright/test";

type Sample = {
	time: number;
	height: number;
	frameHeight: number | null;
	topGap: number;
	bottomGap: number;
	frameBottomGap: number | null;
};

declare global {
	interface Window {
		__liveToolGeometry: Sample[];
	}
}

// Observe actual painted geometry, including Suspense and credential transitions.
export async function recordLiveToolGeometry(page: Page) {
	await page.addInitScript(() => {
		window.__liveToolGeometry = [];
		function sample() {
			const dashboard = document.querySelector("#dashboard-scroll-container");
			const header = dashboard?.querySelector(":scope > header");
			const surface = document.querySelector('[data-testid="hosted-agent-live-surface"]');
			const box = surface?.getBoundingClientRect();
			if (dashboard && header && box && box.width > 0 && box.height > 0) {
				const frame = surface?.querySelector("iframe")?.getBoundingClientRect();
				window.__liveToolGeometry.push({
					time: performance.now(),
					height: box.height,
					frameHeight: frame?.height ?? null,
					topGap: box.top - header.getBoundingClientRect().bottom,
					bottomGap: dashboard.getBoundingClientRect().bottom - box.bottom,
					frameBottomGap: frame ? box.bottom - frame.bottom : null,
				});
			}
			requestAnimationFrame(sample);
		}
		requestAnimationFrame(sample);
	});
}

export async function expectRecordedLiveToolGeometry(page: Page, testInfo: TestInfo) {
	const samples = await page.evaluate(() => window.__liveToolGeometry);
	await testInfo.attach("live-tool-geometry", {
		body: JSON.stringify(samples, null, 2),
		contentType: "application/json",
	});
	expect(samples.length).toBeGreaterThan(0);
	expect(
		samples.filter(
			(sample) =>
				Math.abs(sample.topGap) > 1 ||
				Math.abs(sample.bottomGap) > 1 ||
				(sample.frameBottomGap !== null && Math.abs(sample.frameBottomGap) > 1),
		),
		"Every visible console frame must fill the dashboard below its header",
	).toEqual([]);
}
