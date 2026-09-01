import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(desktopRoot, "src");
const outputRoot = join(desktopRoot, "dist");
const webRoot = join(desktopRoot, "..", "web");
const webClientRoot = join(webRoot, "dist", "client");
const packagedWebRoot = join(outputRoot, "web");
const PRODUCTION_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsuY2xhd2RpLmFpJA";

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

await buildWebApp();
cpSync(webClientRoot, packagedWebRoot, { recursive: true });
writeFileSync(
	join(outputRoot, "web-assets.json"),
	`${JSON.stringify(listFiles(packagedWebRoot))}\n`,
);
await bundle("main.ts", "main.js", "node", "esm");
await bundle("shell-preload.ts", "shell-preload.cjs", "node", "cjs");
await bundle("connect-preload.ts", "connect-preload.cjs", "node", "cjs");
await bundle("connect-renderer.tsx", "connect-renderer.js", "browser", "esm");
cpSync(join(sourceRoot, "renderer.html"), join(outputRoot, "renderer.html"));
cpSync(join(webRoot, "public", "clawdi-logo-transparent.png"), join(outputRoot, "clawdi-logo.png"));

async function buildWebApp(): Promise<void> {
	const webBuild = Bun.spawn(["bun", "run", "build"], {
		cwd: webRoot,
		env: {
			...process.env,
			NODE_ENV: "production",
			VITE_CLAWDI_DESKTOP_BUILD: "true",
			VITE_CLAWDI_HOSTED: "true",
			VITE_CLAWDI_API_URL: "https://cloud-api.clawdi.ai",
			VITE_CLAWDI_DEPLOY_API_URL: "https://api.clawdi.ai",
			VITE_CLAWDI_LEGACY_DASHBOARD_URL: "https://cloud.clawdi.ai/dashboard",
			VITE_CLERK_JS_URL: "https://cloud.clawdi.ai/assets/clerk.browser.js",
			VITE_CLERK_PUBLISHABLE_KEY:
				process.env.VITE_CLERK_PUBLISHABLE_KEY?.trim() || PRODUCTION_CLERK_PUBLISHABLE_KEY,
			VITE_POSTHOG_TOKEN: "",
			VITE_CUSTOMERIO_CDP_WRITE_KEY: "",
			VITE_SENTRY_DSN: "",
			VITE_STRIPE_PUBLISHABLE_KEY: "",
			SENTRY_AUTH_TOKEN: "",
			SENTRY_ORG: "",
			SENTRY_PROJECT: "",
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await webBuild.exited;
	if (exitCode !== 0) throw new Error(`Web build failed with exit ${exitCode}.`);
	if (!existsSync(join(webClientRoot, "index.html"))) {
		throw new Error("Web build did not produce the Desktop SPA shell.");
	}
}

function listFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
		}
	};
	visit(root);
	return files.sort();
}

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
		external: target === "node" ? ["electron", "electron-updater"] : [],
		minify: true,
		sourcemap: "none",
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error(`Could not build ${entry}.`);
	}
}
