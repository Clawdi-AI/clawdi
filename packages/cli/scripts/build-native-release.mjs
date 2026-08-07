#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TARGET_CATALOG, nativeAssetName } from "../src/lib/native-release-manifest.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const nativeRoot = resolve(cliRoot, "dist-native");
const releaseRoot = resolve(cliRoot, "dist-release");
const version = JSON.parse(readFileSync(resolve(cliRoot, "package.json"), "utf8")).version;

rmSync(nativeRoot, { recursive: true, force: true });
rmSync(releaseRoot, { recursive: true, force: true });

const artifacts = [];
for (const { target } of NATIVE_TARGET_CATALOG) {
	const asset = nativeAssetName(target);
	run(resolve(scriptDir, "build-native.mjs"), [], {
		CLAWDI_NATIVE_TARGET: target,
	});
	run(resolve(scriptDir, "package-native-release.mjs"), [], {
		CLAWDI_NATIVE_TARGET: target,
	});
	const sha256 = createHash("sha256")
		.update(readFileSync(resolve(releaseRoot, asset)))
		.digest("hex");
	artifacts.push(`artifact\t${target}\t${asset}\t${sha256}`);
}

writeFileSync(
	resolve(releaseRoot, "clawdi-cli-manifest.txt"),
	[`clawdi.nativeRelease.v1`, `version\t${version}`, ...artifacts, ""].join("\n"),
);
console.log(`built native release matrix for ${version}`);

function run(command, args, extraEnv) {
	const result = spawnSync(process.execPath, [command, ...args], {
		cwd: cliRoot,
		env: { ...process.env, ...extraEnv },
		stdio: "inherit",
	});
	if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}`);
}
