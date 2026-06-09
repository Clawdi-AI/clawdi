#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const packageJson = JSON.parse(readFileSync(resolve(cliRoot, "package.json"), "utf-8"));

const target = process.env.CLAWDI_BINARY_TARGET || "bun-linux-x64-baseline";
const outfile = resolve(cliRoot, process.env.CLAWDI_BINARY_OUTFILE || "dist-bin/clawdi");
const defaultApiUrl = process.env.CLAWDI_DEFAULT_API_URL || "https://cloud-api.clawdi.ai";

rmSync(dirname(outfile), { recursive: true, force: true });
mkdirSync(dirname(outfile), { recursive: true });

const result = await Bun.build({
	entrypoints: [resolve(cliRoot, "src/index.ts")],
	compile: {
		target,
		outfile,
	},
	define: {
		CLAWDI_CLI_VERSION: JSON.stringify(packageJson.version),
		"process.env.CLAWDI_DEFAULT_API_URL": JSON.stringify(defaultApiUrl),
	},
	minify: true,
});

if (!result.success) {
	for (const log of result.logs) console.error(log.message);
	process.exit(1);
}

console.log(`built ${outfile} (${target})`);

if (process.env.CLAWDI_SKIP_MITM_BROKER_BUNDLE !== "1") {
	const bundleOutdir = resolve(dirname(outfile), "clawdi-mitm-broker");
	const result = spawnSync(
		"bun",
		["run", resolve(cliRoot, "scripts", "build-mitm-broker-bundle.mjs")],
		{
			encoding: "utf8",
			env: {
				...process.env,
				CLAWDI_MITM_BROKER_BUNDLE_OUTDIR: bundleOutdir,
			},
			stdio: "pipe",
		},
	);
	if (result.status !== 0) {
		throw new Error(`MITM broker bundle build failed\n${result.stdout}${result.stderr}`);
	}
	if (result.stdout.trim()) process.stdout.write(result.stdout);
	if (result.stderr.trim()) process.stderr.write(result.stderr);
} else {
	console.log("skipped MITM broker bundle (CLAWDI_SKIP_MITM_BROKER_BUNDLE=1)");
}
