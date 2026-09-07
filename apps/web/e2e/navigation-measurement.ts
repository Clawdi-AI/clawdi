import { expect, type Page, type Request, type TestInfo } from "@playwright/test";

export type NavigationIntent = "none" | "hover" | "focus" | "touch";

type NavigationSample = {
	start: number;
	paint: number | null;
	contentReady: number | null;
	dataReady: number | null;
	frames: {
		t: number;
		frame: { x: number; y: number; width: number; height: number } | null;
		live: boolean;
	}[];
	longTasks: { start: number; duration: number }[];
};

declare global {
	interface Window {
		__navigationSample?: NavigationSample;
	}
}

/** Sample the rendered frame, not location changes or Playwright's URL auto-wait. */
export async function measureNavigation(
	page: Page,
	testInfo: TestInfo,
	{
		name,
		href,
		destination,
		intent = "none",
	}: { name: string; href: string; destination: string; intent?: NavigationIntent },
) {
	const link = page.locator(`a[href="${href}"]:visible`).first();
	await expect(link).toBeVisible();
	const requests = new Map<Request, { start: number; end: number | null }>();
	const pending = new Set<Request>();
	const isDataRequest = (request: Request) =>
		new URL(request.url()).hostname === "127.0.0.1" &&
		!/\/events(?:\?|$)|\/stream(?:\?|$)/.test(request.url());
	const onRequest = (request: Request) => {
		if (!["fetch", "xhr", "script"].includes(request.resourceType())) return;
		requests.set(request, { start: Date.now(), end: null });
		if (isDataRequest(request)) pending.add(request);
	};
	const onSettled = (request: Request) => {
		pending.delete(request);
		const timing = requests.get(request);
		if (timing) timing.end = Date.now();
	};
	page.on("request", onRequest);
	page.on("requestfinished", onSettled);
	page.on("requestfailed", onSettled);
	const intentStart = await page.evaluate(() => performance.timeOrigin + performance.now());
	await page.evaluate(
		({ href, destination }) => {
			window.__navigationSample = undefined;
			document.addEventListener(
				"click",
				() => {
					const start = performance.now();
					const result: NavigationSample = {
						start: performance.timeOrigin + start,
						paint: null,
						contentReady: null,
						dataReady: null,
						frames: [],
						longTasks: [],
					};
					window.__navigationSample = result;
					const observer = new PerformanceObserver((list) => {
						for (const entry of list.getEntries())
							result.longTasks.push({ start: entry.startTime - start, duration: entry.duration });
					});
					observer.observe({ type: "longtask" });
					function sample() {
						const t = performance.now() - start;
						const iframe = document.querySelector("main iframe");
						const rect = iframe?.getBoundingClientRect();
						result.frames.push({
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
							result.paint ??= t;
							if (!document.querySelector('main [data-slot="skeleton"], main [aria-busy="true"]'))
								result.contentReady ??= t;
						}
						if (result.dataReady !== null || t > 20_000) {
							observer.disconnect();
							return;
						}
						requestAnimationFrame(sample);
					}
					sample();
				},
				{ once: true, capture: true },
			);
			if (
				!Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).some(
					(link) => new URL(link.href).pathname === href && link.getBoundingClientRect().width > 0,
				)
			)
				throw new Error(`Missing navigation link: ${href}`);
		},
		{ href, destination },
	);
	if (intent === "hover" || intent === "focus") {
		if (intent === "hover") await link.hover();
		else await link.focus();
		// A fixed human intent window, not an application preload-delay change.
		await page.waitForTimeout(1000);
		if (intent === "focus") await page.keyboard.press("Enter");
		else await link.click();
	} else if (intent === "touch") {
		await link.scrollIntoViewIfNeeded();
		const box = await link.boundingBox();
		if (!box) throw new Error("Touch target has no bounds");
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
	} else {
		await link.evaluate((element) => {
			if (!(element instanceof HTMLAnchorElement)) throw new Error("Expected a navigation link");
			element.click();
		});
	}
	await page.waitForFunction(() => window.__navigationSample?.paint != null);
	await expect(page.locator('main [data-slot="skeleton"], main [aria-busy="true"]')).toHaveCount(0);
	await expect.poll(() => pending.size).toBe(0);
	const samples = await page.evaluate(() => {
		const result = window.__navigationSample;
		if (!result || result.paint === null) throw new Error("Navigation has not painted");
		result.dataReady = performance.timeOrigin + performance.now() - result.start;
		return result;
	});
	// Keep the observer/polling hand-off overhead out of the data-ready metric.
	samples.dataReady = Math.max(
		samples.contentReady ?? samples.paint ?? 0,
		...Array.from(requests)
			.filter(([request, timing]) => isDataRequest(request) && timing.end !== null)
			.map(([, timing]) => (timing.end ?? samples.start) - samples.start),
	);
	page.off("request", onRequest);
	page.off("requestfinished", onSettled);
	page.off("requestfailed", onSettled);
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
		body: JSON.stringify(
			{
				...samples,
				intent,
				intentLead: samples.start - intentStart,
				requests: Array.from(requests, ([request, timing]) => ({
					url: request.url(),
					type: request.resourceType(),
					start: timing.start - samples.start,
					end: timing.end === null ? null : timing.end - samples.start,
				})),
				overview,
			},
			null,
			2,
		),
		contentType: "application/json",
	});
	if (process.env.NAVIGATION_BASELINE !== "true") {
		const frames = samples.frames.filter((sample) => sample.frame !== null);
		const initial = frames[0]?.frame;
		expect(
			frames.filter(
				(sample) =>
					!sample.live ||
					(sample.frame &&
						initial &&
						(["x", "y", "width", "height"] as const).some((dimension) => {
							return sample.frame && Math.abs(sample.frame[dimension] - initial[dimension]) > 1;
						})),
			),
			"Outgoing iframe geometry must remain stable",
		).toEqual([]);
	}
	return {
		name,
		intent,
		paint: samples.paint,
		dataReady: samples.dataReady,
		requests: requests.size,
	};
}
