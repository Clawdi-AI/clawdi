#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	isNativeTarget,
	nativeAssetName,
	nativeTargetForPlatform,
} from "../src/lib/native-release-manifest.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDir, "..");
const requestedTarget =
	process.env.CLAWDI_NATIVE_TARGET || nativeTargetForPlatform(process.platform, process.arch);
if (!requestedTarget || !isNativeTarget(requestedTarget)) {
	throw new Error(`unsupported native package target: ${requestedTarget ?? "unknown"}`);
}
const nativeDir = resolve(cliRoot, "dist-native", requestedTarget);
const outdir = resolve(cliRoot, "dist-release");
const assetName = nativeAssetName(requestedTarget);
const assetPath = resolve(outdir, assetName);

mkdirSync(outdir, { recursive: true });

run("test", ["-x", resolve(nativeDir, "clawdi")]);
run("test", ["-f", resolve(nativeDir, "egress-addon", "clawdi_egress_addon.py")]);
run("test", ["-f", resolve(nativeDir, "skills", "clawdi", "SKILL.md")]);
run("test", ["-f", resolve(nativeDir, "skills", "hosted-versions", "1", "clawdi", "SKILL.md")]);
run("test", [
	"-f",
	resolve(nativeDir, "runtime-adapters", "whatsapp", "openclaw", "openclaw.plugin.json"),
]);
run("test", ["-f", resolve(nativeDir, "runtime-adapters", "whatsapp", "hermes", "plugin.yaml")]);
run("tar", [
	"-C",
	nativeDir,
	"--owner=0",
	"--group=0",
	"--numeric-owner",
	"-czf",
	assetPath,
	"clawdi",
	"egress-addon",
	"skills",
	"runtime-adapters",
]);

console.log(`packaged ${assetPath}`);

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
		);
	}
	if (result.stderr.trim()) process.stderr.write(result.stderr);
	return result.stdout;
}
