import { expect, test } from "@playwright/test";
import {
	FRAMEWORK_BRAND_ICON_IDS,
	PROVIDER_BRAND_ICON_IDS,
} from "../src/components/entity-brand-icon-ids";

test("keeps every shared LobeHub brand mark full and contained", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1440, height: 2400 });
	await page.goto("/");
	await page.setContent(`<!doctype html>
		<html lang="en" class="dark">
			<head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
			<body><div id="brand-icon-gallery"></div><script type="module" src="/e2e/brand-icon-gallery.browser.tsx"></script></body>
		</html>`);

	const icons = page.locator('[data-icon-source="lobehub"]');
	const expectedIconCount =
		FRAMEWORK_BRAND_ICON_IDS.length * 3 + PROVIDER_BRAND_ICON_IDS.length * 2;
	await expect(icons).toHaveCount(expectedIconCount);

	const measurements = await icons.evaluateAll((elements) =>
		elements.map((element) => {
			if (!(element instanceof SVGSVGElement) || !(element.parentElement instanceof HTMLElement)) {
				throw new Error("Expected an SVG brand mark inside an HTML tile.");
			}
			const icon = element.getBoundingClientRect();
			const tile = element.parentElement.getBoundingClientRect();
			const artwork = element.getBBox();
			const iconStyle = getComputedStyle(element);
			const tileStyle = getComputedStyle(element.parentElement);
			const matrix = element.getScreenCTM();
			if (!matrix) throw new Error("Expected the brand mark to have a screen transform.");
			const artworkCorners = [
				new DOMPoint(artwork.x, artwork.y).matrixTransform(matrix),
				new DOMPoint(artwork.x + artwork.width, artwork.y).matrixTransform(matrix),
				new DOMPoint(artwork.x, artwork.y + artwork.height).matrixTransform(matrix),
				new DOMPoint(artwork.x + artwork.width, artwork.y + artwork.height).matrixTransform(matrix),
			];
			const artworkLeft = Math.min(...artworkCorners.map((point) => point.x));
			const artworkRight = Math.max(...artworkCorners.map((point) => point.x));
			const artworkTop = Math.min(...artworkCorners.map((point) => point.y));
			const artworkBottom = Math.max(...artworkCorners.map((point) => point.y));
			const cell = element.closest("[data-brand-cell]");
			return {
				id: cell?.getAttribute("data-brand-id"),
				kind: cell?.getAttribute("data-brand-kind"),
				surface: cell?.getAttribute("data-brand-surface"),
				iconWidth: icon.width,
				iconHeight: icon.height,
				iconColor: iconStyle.color,
				tileWidth: tile.width,
				tileHeight: tile.height,
				tileBackground: tileStyle.backgroundColor,
				artworkWidth: artworkRight - artworkLeft,
				artworkHeight: artworkBottom - artworkTop,
				widthAttribute: element.getAttribute("width"),
				heightAttribute: element.getAttribute("height"),
				contained:
					icon.left >= tile.left &&
					icon.top >= tile.top &&
					icon.right <= tile.right &&
					icon.bottom <= tile.bottom &&
					artworkLeft >= tile.left &&
					artworkTop >= tile.top &&
					artworkRight <= tile.right &&
					artworkBottom <= tile.bottom,
				noOverflow:
					element.parentElement.scrollWidth <= element.parentElement.clientWidth &&
					element.parentElement.scrollHeight <= element.parentElement.clientHeight,
				minimumMargin: Math.min(
					icon.left - tile.left,
					icon.top - tile.top,
					tile.right - icon.right,
					tile.bottom - icon.bottom,
				),
			};
		}),
	);

	for (const measurement of measurements) {
		expect(measurement.widthAttribute, `${measurement.id} width`).toBe("84%");
		expect(measurement.heightAttribute, `${measurement.id} height`).toBe("84%");
		expect(measurement.contained, `${measurement.id} artwork containment`).toBe(true);
		expect(measurement.noOverflow, `${measurement.id} tile overflow`).toBe(true);
		expect(measurement.iconWidth, `${measurement.id} visible fill`).toBeGreaterThan(
			measurement.tileWidth * 0.75,
		);
		expect(measurement.iconHeight, `${measurement.id} visible fill`).toBeGreaterThan(
			measurement.tileHeight * 0.75,
		);
		expect(measurement.iconWidth, `${measurement.id} safety space`).toBeLessThan(
			measurement.tileWidth * 0.81,
		);
		expect(measurement.iconHeight, `${measurement.id} safety space`).toBeLessThan(
			measurement.tileHeight * 0.81,
		);
		expect(measurement.minimumMargin, `${measurement.id} edge margin`).toBeGreaterThan(2.5);
	}

	const frameworkMeasurements = measurements.filter(({ kind }) => kind === "framework");
	const providerMeasurements = measurements.filter(({ kind }) => kind === "provider");
	for (const id of FRAMEWORK_BRAND_ICON_IDS) {
		const frameworkIcons = frameworkMeasurements.filter((measurement) => measurement.id === id);
		expect(frameworkIcons).toHaveLength(3);
		if (id === "hermes") {
			for (const icon of frameworkIcons) {
				expect(icon.iconColor).toBe("rgb(0, 0, 0)");
				expect(icon.tileBackground).toBe("rgb(255, 255, 255)");
			}
		}
	}
	for (const id of PROVIDER_BRAND_ICON_IDS) {
		expect(providerMeasurements.filter((measurement) => measurement.id === id)).toHaveLength(2);
	}

	await page.screenshot({
		path: testInfo.outputPath("brand-icon-geometry-84.png"),
		fullPage: true,
	});
});
