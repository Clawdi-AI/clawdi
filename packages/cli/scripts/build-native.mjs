#!/usr/bin/env bun
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	NATIVE_TARGET_CATALOG,
	nativeTargetForPlatform,
} from "../src/lib/native-release-manifest.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const packageJson = JSON.parse(readFileSync(resolve(cliRoot, "package.json"), "utf-8"));

const hostNativeTarget = nativeTargetForPlatform(process.platform, process.arch);
const nativeTarget = process.env.CLAWDI_NATIVE_TARGET || hostNativeTarget;
if (!nativeTarget)
	throw new Error(`unsupported native build host: ${process.platform}-${process.arch}`);
const targetEntry = NATIVE_TARGET_CATALOG.find((entry) => entry.target === nativeTarget);
if (!targetEntry) throw new Error(`unsupported native build target: ${nativeTarget}`);
const outputDirectory = resolve(cliRoot, "dist-native", targetEntry.target);
const outfile = resolve(outputDirectory, "clawdi");
const defaultApiUrl = process.env.CLAWDI_DEFAULT_API_URL || "https://cloud-api.clawdi.ai";
const defaultDeployApiUrl = process.env.CLAWDI_DEFAULT_DEPLOY_API_URL || "https://api.clawdi.ai";

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const result = await Bun.build({
	entrypoints: [resolve(cliRoot, "src/index.ts")],
	compile: {
		target: targetEntry.bunTarget,
		outfile,
	},
	define: {
		CLAWDI_CLI_VERSION: JSON.stringify(packageJson.version),
		CLAWDI_NATIVE_TARGET: JSON.stringify(targetEntry.target),
		"process.env.CLAWDI_DEFAULT_API_URL": JSON.stringify(defaultApiUrl),
		"process.env.CLAWDI_DEFAULT_DEPLOY_API_URL": JSON.stringify(defaultDeployApiUrl),
	},
	minify: true,
});

if (!result.success) {
	for (const log of result.logs) console.error(log.message);
	process.exit(1);
}

console.log(`built ${outfile} (${targetEntry.bunTarget})`);

cpSync(resolve(cliRoot, "egress-addon"), resolve(outputDirectory, "egress-addon"), {
	recursive: true,
});
console.log(`copied egress addon to ${resolve(outputDirectory, "egress-addon")}`);

cpSync(resolve(cliRoot, "skills"), resolve(outputDirectory, "skills"), {
	recursive: true,
});
console.log(`copied bundled skills to ${resolve(outputDirectory, "skills")}`);
