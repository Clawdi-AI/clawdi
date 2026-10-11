#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import {
	isNativeBuildTarget,
	nativeAssetName,
	nativeBuildTargetForPlatform,
	nativeExecutableName,
} from "../src/lib/native-release-manifest.ts";
import { validateNativePublicationArchive } from "./native-publication.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const requestedTarget =
	process.env.CLAWDI_NATIVE_TARGET || nativeBuildTargetForPlatform(process.platform, process.arch);
if (!requestedTarget || !isNativeBuildTarget(requestedTarget)) {
	throw new Error(`unsupported native package target: ${requestedTarget ?? "unknown"}`);
}
// Signing repacks an extracted payload into the downloaded release directory.
const nativeDir = process.argv[2]
	? resolve(process.argv[2])
	: resolve(cliRoot, "dist-native", requestedTarget);
const outdir = process.argv[3] ? resolve(process.argv[3]) : resolve(cliRoot, "dist-release");
const assetName = nativeAssetName(requestedTarget);
const assetPath = resolve(outdir, assetName);
const executableName = nativeExecutableName(requestedTarget);

mkdirSync(outdir, { recursive: true });

run("test", [executableName === "clawdi.exe" ? "-f" : "-x", resolve(nativeDir, executableName)]);
run("test", ["-f", resolve(nativeDir, "egress-addon", "clawdi_egress_addon.py")]);
run("test", ["-f", resolve(nativeDir, "skills", "clawdi", "SKILL.md")]);
run("test", ["-f", resolve(nativeDir, "skills", "hosted-versions", "1", "clawdi", "SKILL.md")]);
// Explicit traversal keeps entry order stable across filesystems. Portable
// metadata and omitted timestamps make unchanged payloads byte-reproducible.
const entries = [executableName, "egress-addon/clawdi_egress_addon.py"];
collectEntries("skills");
await tar.create(
	{
		cwd: nativeDir,
		file: assetPath,
		gzip: true,
		portable: true,
		noMtime: true,
		noDirRecurse: true,
		strict: true,
	},
	entries,
);
await validateNativePublicationArchive(readFileSync(assetPath), executableName);

console.log(`packaged ${assetPath}`);

function collectEntries(path) {
	entries.push(path);
	if (lstatSync(resolve(nativeDir, path)).isDirectory()) {
		for (const name of readdirSync(resolve(nativeDir, path)).sort()) {
			collectEntries(`${path}/${name}`);
		}
	}
}

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
		);
	}
	if (result.stderr?.trim()) process.stderr.write(result.stderr);
	return result.stdout;
}
