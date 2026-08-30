import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(desktopRoot, "src");
const outputRoot = join(desktopRoot, "dist");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

await bundle("main.ts", "main.js", "node", "esm");
await bundle("shell-preload.ts", "shell-preload.cjs", "node", "cjs");
await bundle("connect-preload.ts", "connect-preload.cjs", "node", "cjs");
await bundle("connect-renderer.tsx", "connect-renderer.js", "browser", "esm");
cpSync(join(sourceRoot, "renderer.html"), join(outputRoot, "renderer.html"));

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
		external: target === "node" ? ["electron"] : [],
		minify: true,
		sourcemap: "none",
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error(`Could not build ${entry}.`);
	}
}
