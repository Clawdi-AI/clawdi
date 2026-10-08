/**
 * Builds the browser favicons and Web app manifest icons from the brand
 * artwork (docs/images/logo.png, 800px, the master that apps/mobile's
 * `bun run icons` also reads; public/clawdi-logo-transparent.png is its 512px
 * square). Only scaling and the corner mask are applied; no artwork is redrawn.
 *
 * - favicon.ico (16/32/48), favicon-16x16.png, favicon-32x32.png and the
 *   manifest's `any` icons are rounded squares with transparent corners.
 * - apple-touch-icon.png is full-bleed and opaque: iOS applies its own mask.
 * - maskable-icon-512x512.png scales the whole mark into the maskable safe zone
 *   (https://www.w3.org/TR/appmanifest/#icon-masks) on a full-bleed field of
 *   the artwork's own red, so launcher masks of any shape keep it intact.
 *
 * PNGs use sharp's lossless zlib settings only. Outputs are byte-identical in
 * the verified generation environment (Linux x64, sharp 0.34.5, libvips 8.17.3);
 * cross-platform byte reproducibility is unverified. Run `bun run icons` after
 * changing the artwork, then copy the same files to clawdi-hosted's apps/web/public
 * so both sites ship identical icons. Hosted verifies these copies via
 * `apps/web/brand-icons.sha256`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const artworkPath = fileURLToPath(new URL("../../../docs/images/logo.png", import.meta.url));
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

/** Rounded-square corners, the iOS app icon proportion used across Clawdi surfaces. */
const CORNER_RATIO = 0.2237;
const ICO_SIZES = [16, 32, 48];
/** Maskable safe zone: a centered circle whose radius is 40% of the icon. */
const MASKABLE_SAFE_RADIUS = 0.4;
const MASKABLE_SIZE = 512;

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

/** The artwork is cream line art on a flat red field; find the field and the mark's reach. */
async function measureArtwork() {
	const { data, info } = await sharp(artworkPath)
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const { width, height, channels } = info;
	if (width !== height) throw new Error("Expected square artwork");
	const at = (x: number, y: number) => (y * width + x) * channels;
	const field = { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0 };
	const differs = (index: number) =>
		data[index] !== field.r || data[index + 1] !== field.g || data[index + 2] !== field.b;
	if ([at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)].some(differs))
		throw new Error("Expected a flat artwork background");
	// Farthest corner of any non-field pixel from the center, in artwork widths.
	let reach = 0;
	const center = width / 2;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			if (differs(at(x, y)))
				reach = Math.max(
					reach,
					Math.hypot(Math.abs(x + 0.5 - center) + 0.5, Math.abs(y + 0.5 - center) + 0.5) / width,
				);
	return { width, field, reach };
}

async function generate() {
	const { width, field, reach } = await measureArtwork();
	const mask = Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}"><rect width="${width}" height="${width}" rx="${width * CORNER_RATIO}"/></svg>`,
	);
	// Mask at full resolution so every size downsamples the same anti-aliased edge.
	const rounded = await sharp(artworkPath)
		.ensureAlpha()
		.composite([{ input: mask, blend: "dest-in" }])
		.png()
		.toBuffer();
	const resize = (input: Buffer | string, size: number) => sharp(input).resize(size, size);
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
	const markSize = Math.floor((MASKABLE_SIZE * MASKABLE_SAFE_RADIUS) / reach);
	const maskable = sharp({
		create: { width: MASKABLE_SIZE, height: MASKABLE_SIZE, channels: 3, background: field },
	}).composite([
		{ input: await resize(artworkPath, markSize).removeAlpha().toBuffer(), gravity: "center" },
	]);
	await write("maskable-icon-512x512.png", png(maskable));
}

if (import.meta.main) await generate();
