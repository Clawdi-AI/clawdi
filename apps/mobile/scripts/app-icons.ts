/**
 * Builds the native app icon, Android adaptive icon layers, and splash image
 * from the brand artwork (docs/images/logo.png, 800px, the largest master; the
 * Web dashboard ships the same artwork at 512px). Sizes above 800px are
 * upscaled with Lanczos3; no artwork is redrawn. Splash backgrounds come from
 * the shared `--background` tokens so launch surfaces match the first app frame.
 *
 * Run `bun run icons` after changing the artwork or the shared background tokens;
 * `app-icons.test.ts` fails when the committed theme colors are stale.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { block, declarations, hexColor, readSharedTheme } from "./theme";

const artworkPath = fileURLToPath(new URL("../../../docs/images/logo.png", import.meta.url));
const assetsDir = fileURLToPath(new URL("../assets/", import.meta.url));
export const colorsPath = fileURLToPath(new URL("../assets/app-colors.json", import.meta.url));

const CANVAS = 1024;
/**
 * Adaptive icon foreground: a 108dp canvas whose 66dp safe-zone circle must
 * hold the face. Its farthest point sits 0.40 artwork-widths from the center,
 * so the artwork may span at most 0.305 / 0.40 = 0.76 of the canvas.
 */
const ADAPTIVE_ARTWORK = Math.round(CANVAS * 0.76);
/** Rounded-square splash corners, matching the iOS app icon proportion. */
const SPLASH_CORNER_RATIO = 0.2237;

export function buildAppColors(css: string) {
	const background = (selector: string) => {
		const value = declarations(block(css, selector)).get("--background");
		if (!value) throw new Error(`Shared theme is missing --background in ${selector}`);
		return hexColor(value);
	};
	return { light: background(":root"), dark: background(".dark") };
}

async function generate() {
	const { default: sharp } = await import("sharp");
	const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
	const { data, info } = await sharp(artworkPath).raw().toBuffer({ resolveWithObject: true });
	// The artwork is two flat inks: a red field and cream line art.
	const pixelHex = (index: number) =>
		`#${[...data.subarray(index * info.channels, index * info.channels + 3)]
			.map((value) => value.toString(16).padStart(2, "0"))
			.join("")}`;
	const red = pixelHex(0);
	const corners = [info.width - 1, (info.height - 1) * info.width, info.height * info.width - 1];
	if (corners.some((index) => pixelHex(index) !== red))
		throw new Error("Expected a flat artwork background");
	const artwork = (size: number) => sharp(artworkPath).resize(size, size, { kernel: "lanczos3" });
	const centered = (input: Buffer) =>
		sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: transparent } })
			.composite([{ input, gravity: "center" }])
			.png();

	mkdirSync(assetsDir, { recursive: true });
	// App Store icon: full-bleed and opaque.
	await artwork(CANVAS).removeAlpha().png().toFile(`${assetsDir}icon.png`);
	await centered(await artwork(ADAPTIVE_ARTWORK).png().toBuffer()).toFile(
		`${assetsDir}adaptive-icon.png`,
	);
	// Android themed icons use only alpha: the cream line art, keyed off the red field.
	const grey = await artwork(ADAPTIVE_ARTWORK).greyscale().extractChannel(0).raw().toBuffer();
	const field = grey[0] ?? 0;
	const ink = grey.reduce((max, value) => Math.max(max, value), 0);
	const scale = 255 / (ink - field);
	const lineArt = await sharp(grey, {
		raw: { width: ADAPTIVE_ARTWORK, height: ADAPTIVE_ARTWORK, channels: 1 },
	})
		.linear(scale, -field * scale)
		.extractChannel(0)
		.raw()
		.toBuffer();
	const monochrome = await sharp({
		create: {
			width: ADAPTIVE_ARTWORK,
			height: ADAPTIVE_ARTWORK,
			channels: 3,
			background: "#ffffff",
		},
	})
		.joinChannel(lineArt, {
			raw: { width: ADAPTIVE_ARTWORK, height: ADAPTIVE_ARTWORK, channels: 1 },
		})
		.png()
		.toBuffer();
	await centered(monochrome).toFile(`${assetsDir}adaptive-icon-monochrome.png`);
	const radius = Math.round(CANVAS * SPLASH_CORNER_RATIO);
	const mask = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}"><rect width="${CANVAS}" height="${CANVAS}" rx="${radius}"/></svg>`,
	);
	await artwork(CANVAS)
		.ensureAlpha()
		.composite([{ input: mask, blend: "dest-in" }])
		.png()
		.toFile(`${assetsDir}splash-icon.png`);
	writeFileSync(
		colorsPath,
		`${JSON.stringify({ ...buildAppColors(readSharedTheme()), brand: red }, null, "\t")}\n`,
	);
}

if (import.meta.main) await generate();
