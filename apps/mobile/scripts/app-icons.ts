/**
 * Builds the native app icon, Android adaptive icon layers, and splash marks from
 * the Web brand master (apps/web/public/clawdi.svg). Background colors come from
 * the shared `--background` tokens so launch surfaces match the first app frame.
 *
 * Run `bun run icons` after changing the logo or the shared background tokens;
 * `app-icons.test.ts` fails when the committed colors are stale.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { block, declarations, readSharedTheme } from "./theme";

const logoPath = fileURLToPath(new URL("../../web/public/clawdi.svg", import.meta.url));
const assetsDir = fileURLToPath(new URL("../assets/", import.meta.url));
export const colorsPath = fileURLToPath(new URL("../assets/app-colors.json", import.meta.url));

const CANVAS = 1024;
/** iOS/legacy icon: the mark's longest side relative to the canvas. */
const ICON_MARK = 640;
/** Adaptive icon foreground (108dp canvas): the mark stays inside the 66dp safe-zone circle. */
const SAFE_MARK = 480;

/** oklch() → sRGB hex via OKLab (https://bottosson.github.io/posts/oklab/). */
export function oklchToHex(value: string): string {
	const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
	if (!match) throw new Error(`Expected an opaque oklch() color, received ${value}`);
	const [lightness, chroma, hue] = match.slice(1).map(Number) as [number, number, number];
	const a = chroma * Math.cos((hue * Math.PI) / 180);
	const b = chroma * Math.sin((hue * Math.PI) / 180);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const linear = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	return `#${linear
		.map((channel) => {
			const encoded = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
			return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
				.toString(16)
				.padStart(2, "0");
		})
		.join("")}`;
}

export function buildAppColors(css: string) {
	const background = (selector: string) => {
		const value = declarations(block(css, selector)).get("--background");
		if (!value) throw new Error(`Shared theme is missing --background in ${selector}`);
		return oklchToHex(value);
	};
	return { light: background(":root"), dark: background(".dark") };
}

/** Repaints the logo's two layers: the red claw and its near-black outline. */
function recolor(svg: string, { claw, outline }: { claw?: string; outline: string }): string {
	return svg.replace(/fill="#([0-9A-Fa-f]{6})"/g, (match, hex: string) =>
		Number.parseInt(hex.slice(0, 2), 16) > 0x80
			? claw
				? `fill="${claw}"`
				: match
			: `fill="${outline}"`,
	);
}

function darkForeground(css: string): string {
	const value = declarations(block(css, ".dark")).get("--foreground");
	if (!value) throw new Error("Shared theme is missing --foreground in .dark");
	return oklchToHex(value);
}

async function generate() {
	const { default: sharp } = await import("sharp");
	const svg = await Bun.file(logoPath).text();
	const css = readSharedTheme();
	const colors = buildAppColors(css);
	const render = (source: string) => sharp(Buffer.from(source), { density: 288 });
	// Crop every variant to the full mark's bounds so the layers stay aligned.
	const { info } = await render(svg).trim().toBuffer({ resolveWithObject: true });
	const bounds = {
		left: -(info.trimOffsetLeft ?? 0),
		top: -(info.trimOffsetTop ?? 0),
		width: info.width,
		height: info.height,
	};
	const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
	const layer = async (source: string, size: number) => {
		const mark = await render(source)
			.extract(bounds)
			.resize(size, size, { fit: "contain", background: transparent })
			.png()
			.toBuffer();
		return sharp({
			create: { width: CANVAS, height: CANVAS, channels: 4, background: transparent },
		})
			.composite([{ input: mark, gravity: "center" }])
			.png()
			.toBuffer();
	};

	mkdirSync(assetsDir, { recursive: true });
	// App Store icons must be opaque.
	await sharp(await layer(svg, ICON_MARK))
		.flatten({ background: colors.light })
		.removeAlpha()
		.toFile(`${assetsDir}icon.png`);
	await sharp(await layer(svg, SAFE_MARK)).toFile(`${assetsDir}brand-mark.png`);
	// Android themed icons use only alpha: keep the claw, drop the outline.
	await sharp(await layer(recolor(svg, { claw: "#FFFFFF", outline: "none" }), SAFE_MARK)).toFile(
		`${assetsDir}brand-mark-monochrome.png`,
	);
	// Splash marks fill their canvas; `imageWidth` in app.config.js sizes them.
	// The dark outline would vanish on the dark background, so it takes the dark foreground.
	await sharp(await layer(svg, CANVAS)).toFile(`${assetsDir}splash-icon.png`);
	await sharp(await layer(recolor(svg, { outline: darkForeground(css) }), CANVAS)).toFile(
		`${assetsDir}splash-icon-dark.png`,
	);
	writeFileSync(colorsPath, `${JSON.stringify(colors, null, "\t")}\n`);
}

if (import.meta.main) await generate();
