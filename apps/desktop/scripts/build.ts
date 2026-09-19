import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(desktopRoot, "src");
const outputRoot = join(desktopRoot, "dist");
const webRoot = join(desktopRoot, "..", "web");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
for (const [name, size] of [
	["trayTemplate.png", 18],
	["trayTemplate@2x.png", 36],
	["trayWindows.png", 16],
	["trayWindows@2x.png", 32],
	["trayLinux.png", 22],
	["trayLinux@2x.png", 44],
] as const) {
	const source = join(desktopRoot, "build", name);
	const png = readFileSync(source);
	if (
		png.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
		png.readUInt32BE(16) !== size ||
		png.readUInt32BE(20) !== size
	)
		throw new Error(`Invalid tray asset: ${name}`);
	cpSync(source, join(outputRoot, name));
}

await bundle("main.ts", "main.js", "node", "esm");
await bundle("shell-preload.ts", "shell-preload.cjs", "node", "cjs");
await bundle("connect-preload.ts", "connect-preload.cjs", "node", "cjs");
await bundle("connect-renderer.tsx", "connect-renderer.js", "browser", "esm");
cpSync(join(sourceRoot, "renderer.html"), join(outputRoot, "renderer.html"));
cpSync(join(webRoot, "public", "clawdi-logo-transparent.png"), join(outputRoot, "clawdi-logo.png"));

async function bundle(
	entry: string,
	name: string,
	target: "browser" | "node",
	format: "cjs" | "esm",
): Promise<void> {
	const result = await Bun.build({
		entrypoints: [join(sourceRoot, entry)],
		outdir: outputRoot,
		naming: entry.endsWith(".tsx") ? "[name].[ext]" : name,
		target,
		format,
		external: target === "node" ? ["electron", "electron-updater", "builder-util-runtime"] : [],
		minify: true,
		sourcemap: "none",
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error(`Could not build ${entry}.`);
	}
}
