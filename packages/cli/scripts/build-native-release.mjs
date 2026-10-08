#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_BUILD_TARGET_CATALOG } from "../src/lib/native-release-manifest.ts";
import { writeNativeReleaseManifests } from "./native-publication.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const nativeRoot = resolve(cliRoot, "dist-native");
const releaseRoot = resolve(cliRoot, "dist-release");
const version = JSON.parse(readFileSync(resolve(cliRoot, "package.json"), "utf8")).version;

rmSync(nativeRoot, { recursive: true, force: true });
rmSync(releaseRoot, { recursive: true, force: true });

for (const { target } of NATIVE_BUILD_TARGET_CATALOG) {
	run(resolve(scriptDir, "build-native.mjs"), [], {
		CLAWDI_NATIVE_TARGET: target,
	});
	run(resolve(scriptDir, "package-native-release.mjs"), [], {
		CLAWDI_NATIVE_TARGET: target,
	});
}

writeNativeReleaseManifests(releaseRoot, version);
console.log(`built native release matrix for ${version}`);

function run(command, args, extraEnv) {
	const result = spawnSync(process.execPath, [command, ...args], {
		cwd: cliRoot,
		env: { ...process.env, ...extraEnv },
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}`);
}
