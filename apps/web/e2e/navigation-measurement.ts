import { expect, type Page, type TestInfo } from "@playwright/test";

/** Sample the rendered frame, not location changes or Playwright's URL auto-wait. */
export async function measureNavigation(
	page: Page,
	testInfo: TestInfo,
	{ name, href, destination }: { name: string; href: string; destination: string },
) {
	const requests: string[] = [];
	const onRequest = (request: { url(): string; resourceType(): string }) => {
		if (["fetch", "xhr", "script"].includes(request.resourceType())) requests.push(request.url());
	};
	page.on("request", onRequest);
	const samples = await page.evaluate(
		({ href, destination }) =>
			new Promise<{
				paint: number;
				frames: {
					t: number;
					frame: { x: number; y: number; width: number; height: number } | null;
					live: boolean;
				}[];
			}>((resolve, reject) => {
				const link = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).find(
					(link) => new URL(link.href).pathname === href && link.getBoundingClientRect().width > 0,
				);
				if (!link) return reject(new Error(`Missing navigation link: ${href}`));
				const start = performance.now();
				const frames: {
					t: number;
					frame: { x: number; y: number; width: number; height: number } | null;
					live: boolean;
				}[] = [];
				let firstPaint: number | null = null;
				function sample() {
					const t = performance.now() - start;
					const iframe = document.querySelector("main iframe");
					const rect = iframe?.getBoundingClientRect();
					frames.push({
						t,
						frame: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
						live: document.querySelector("main")?.getAttribute("data-live-tool-route") === "true",
					});
					const target = document.querySelector(destination);
					if (
						target &&
						target.getBoundingClientRect().height > 0 &&
						!target.closest('[style*="display: none"]')
					) {
						firstPaint ??= t;
					}
					if (firstPaint !== null && t > firstPaint + 150)
						return resolve({ paint: firstPaint, frames });
					if (t > 20_000) return reject(new Error(`Destination did not paint: ${destination}`));
					requestAnimationFrame(sample);
				}
				sample();
				link.click();
			}),
		{ href, destination },
	);
	page.off("request", onRequest);
	const overview = await page.locator("main").evaluate((main) => {
		const box = (element: Element | null | undefined) =>
			element?.getBoundingClientRect().toJSON() ?? null;
		return {
			sections: ["tools", "entry"].map((id) => ({
				id,
				box: box(main.querySelector(`[data-overview-section="${id}"]`)),
			})),
			headings: Array.from(
				main.querySelectorAll(
					'h2[id$="recent-sessions"], #agent-overview-workspace, #agent-overview-shared',
				),
			).map((heading) => ({
				id: heading.id,
				heading: box(heading),
				row: box(heading.parentElement),
				content: box(heading.parentElement?.nextElementSibling),
			})),
			compute: box(main.querySelector('[data-overview-status="compute"]')),
			computeFacts: Array.from(
				main.querySelectorAll(
					'[data-overview-status="compute"] dt, [data-overview-status="compute"] dd',
				),
			).map((element) => ({ text: element.textContent, box: box(element) })),
		};
	});
	await testInfo.attach(name, {
		body: JSON.stringify({ ...samples, requests, overview }, null, 2),
		contentType: "application/json",
	});
	if (process.env.NAVIGATION_BASELINE !== "true") {
		const frames = samples.frames.filter((sample) => sample.frame !== null);
		for (const sample of frames) {
			expect(sample.live, `old iframe must retain its layout at ${sample.t}ms`).toBe(true);
			if (sample.frame && frames[0]?.frame) {
				for (const dimension of ["x", "y", "width", "height"] as const) {
					expect(
						Math.abs(sample.frame[dimension] - frames[0].frame[dimension]),
						`${dimension} at ${sample.t}ms`,
					).toBeLessThanOrEqual(1);
				}
			}
		}
	}
	return { name, paint: samples.paint, requests: requests.length };
}
