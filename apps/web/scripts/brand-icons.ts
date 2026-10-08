/**
 * Builds the browser favicons and Web app manifest icons from the brand
 * artwork (docs/images/logo.png, 800px, the master that apps/mobile's
 * `bun run icons` also reads; public/clawdi-logo-transparent.png is its 512px
 * square). Only scaling and the corner mask are applied; no artwork is redrawn.
 *
 * - favicon.ico (16/32/48), favicon-16x16.png, favicon-32x32.png and the
 *   manifest's `any` icons are rounded squares with transparent corners.
 * - apple-touch-icon.png and the manifest's `maskable` icon stay full-bleed and
 *   opaque: iOS and Android launchers apply their own masks. The artwork's
 *   face already sits inside the maskable 80% safe-zone circle.
 *
 * Run `bun run icons` after changing the artwork, losslessly recompress the PNGs
 * (`oxipng -o 6 --strip safe public/*.png`), then copy the same files to
 * clawdi-hosted's apps/web/public so both sites ship identical icons.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const artworkPath = fileURLToPath(new URL("../../../docs/images/logo.png", import.meta.url));
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

/** Rounded-square corners, the iOS app icon proportion used across Clawdi surfaces. */
const CORNER_RATIO = 0.2237;
const ICO_SIZES = [16, 32, 48];

const png = (image: sharp.Sharp) =>
	image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();

/** ICO container with PNG-encoded entries, supported by every current browser. */
function ico(images: { size: number; data: Buffer }[]) {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, data }, index) => {
		const entry = 6 + 16 * index;
		header.writeUInt8(size % 256, entry);
		header.writeUInt8(size % 256, entry + 1);
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(data.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += data.length;
	});
	return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

async function generate() {
	const { width, height } = await sharp(artworkPath).metadata();
	if (!width || width !== height) throw new Error("Expected square artwork");
	const mask = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}"><rect width="${width}" height="${width}" rx="${width * CORNER_RATIO}"/></svg>`,
	);
	// Mask at full resolution so every size downsamples the same anti-aliased edge.
	const rounded = await sharp(artworkPath)
		.ensureAlpha()
		.composite([{ input: mask, blend: "dest-in" }])
		.png()
		.toBuffer();
	const resize = (input: Buffer | string, size: number) =>
		sharp(input).resize(size, size, { kernel: "lanczos3" });
	const write = async (file: string, data: Promise<Buffer> | Buffer) =>
		writeFileSync(`${publicDir}${file}`, await data);

	const favicons = await Promise.all(
		ICO_SIZES.map(async (size) => ({ size, data: await png(resize(rounded, size)) })),
	);
	await write("favicon.ico", ico(favicons));
	for (const { size, data } of favicons.filter(({ size }) => size !== 48))
		await write(`favicon-${size}x${size}.png`, data);
	await write("android-chrome-192x192.png", png(resize(rounded, 192)));
	await write("android-chrome-512x512.png", png(resize(rounded, 512)));
	await write("apple-touch-icon.png", png(resize(artworkPath, 180).removeAlpha()));
	await write("maskable-icon-512x512.png", png(resize(artworkPath, 512).removeAlpha()));
}

if (import.meta.main) await generate();
